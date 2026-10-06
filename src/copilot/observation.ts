import type { CombatLogSnapshot } from '../live/combat-log-source.js';
import { ObservationCache } from './observation-cache.js';
import type { PollingLifetime } from './cancellation.js';
import type { CopilotEngineOptions } from './execution-types.js';
import type { GameGateway } from './types.js';
import { currentPhysicalArea, currentPhysicalTile, KMOD_LSHIFT, SDLK_d, SDLK_r } from './workflow-support.js';

/** Serializes game-side inspections and preserves the existing room-arrival recovery. */
export class ObservationCoordinator {
  private readonly settlementTimeoutMilliseconds: number;
  private readonly inspectionTimeoutMilliseconds: number;
  private readonly pollIntervalMilliseconds: number;
  constructor(private readonly game: GameGateway, private readonly lifetime: PollingLifetime, private readonly isActionInFlight: () => boolean, options: CopilotEngineOptions) {
    this.settlementTimeoutMilliseconds = options.settlementTimeoutMilliseconds ?? 6000;
    this.inspectionTimeoutMilliseconds = options.inspectionTimeoutMilliseconds ?? 750;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 100;
  }

  async waitForPending() { if (this.observationWork) await this.observationWork; }

  async forceRefresh(includeMap: boolean) {
    await this.waitForPending();
    if (this.isActionInFlight()) throw new Error('Cannot force an inspection while an action is in flight.');
    const pending = this.inspectFresh(includeMap);
    this.observationWork = pending;
    try { return await pending; } finally { this.observationWork = undefined; }
  }
  private readonly inspectionAttempts = new ObservationCache();
  private readonly mapInspectionAttempts = new ObservationCache();
  private readonly arrivalInspectionAttempts = new ObservationCache();
  private readonly contextInspectionAttempts = new ObservationCache();
  private sourceGeneration?: number;
  private resetSourceCaches(snapshot: CombatLogSnapshot) {
    if (snapshot.source.generation !== this.sourceGeneration) {
      this.inspectionAttempts.clear(); this.mapInspectionAttempts.clear();
      this.arrivalInspectionAttempts.clear(); this.contextInspectionAttempts.clear();
      this.sourceGeneration = snapshot.source.generation;
    }
  }
  private observationWork?: Promise<CombatLogSnapshot>;
  private async inspectFresh(includeMap: boolean): Promise<CombatLogSnapshot> {
    let snapshot = await this.game.refresh();
    this.resetSourceCaches(snapshot);
    if (!snapshot.source.available) throw new Error('Fresh observation failed: the primary log source is unavailable.');
    for (const kind of includeMap ? ['inspect_state', 'inspect_map'] as const : ['inspect_state'] as const) {
      const completedTick = (value: CombatLogSnapshot) => kind === 'inspect_map'
        ? value.state.dungeonMap?.completedTick : value.state.inspection?.completedTick;
      const previousTick = completedTick(snapshot);
      const sourceRevision = snapshot.revision;
      const acknowledgement = await this.game.send({ kind, args: {} });
      if (acknowledgement.status !== 'queued' && acknowledgement.status !== 'accepted') {
        throw new Error(`Fresh observation failed: ${kind} was ${acknowledgement.status}. ${acknowledgement.reason ?? ''}`);
      }
      const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
      let completed = false;
      while (!this.lifetime.closed && Date.now() <= deadline) {
        snapshot = await this.game.refresh();
        if (!snapshot.source.available) throw new Error('Fresh observation failed: the primary log source became unavailable.');
        const tick = completedTick(snapshot);
        const completionKind = kind === 'inspect_map' ? 'map_snapshot_completed' : 'agent_state_completed';
        const completedRecord = this.game.recordsAfter(sourceRevision, 2_000)
          .some((record) => record.event?.kind === completionKind);
        if (tick !== undefined && snapshot.revision > sourceRevision &&
          (tick !== previousTick || completedRecord)) { completed = true; break; }
        await this.lifetime.wait(this.pollIntervalMilliseconds);
      }
      this.lifetime.ensureOpen();
      if (!completed) throw new Error(`Fresh observation timed out: no new completed ${kind} snapshot arrived.`);
    }
    return snapshot;
  }
  async getSnapshot(): Promise<CombatLogSnapshot> {
    if (this.isActionInFlight()) return this.game.refresh();
    if (this.observationWork) return this.observationWork;
    const pending = this.refreshWithInspectionOnce();
    this.observationWork = pending;
    try { return await pending; } finally { this.observationWork = undefined; }
  }
  private async refreshWithInspectionOnce(): Promise<CombatLogSnapshot> {
    let snapshot = await this.game.refresh();
    this.resetSourceCaches(snapshot);
    if (this.isActionInFlight()) return snapshot;
    const actor = snapshot.state.currentActor;
    if (
      snapshot.state.combatActive &&
      snapshot.state.phase === "combat" &&
      actor !== undefined &&
      snapshot.state.inspection?.actorAddress !== actor.address
    ) {
      const attemptKey = `${actor.address}:${actor.turnTick}`;
      if (!this.inspectionAttempts.has(attemptKey)) {
        this.inspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const acknowledgement = await this.game.send({
          kind: "inspect_state",
          args: {},
        });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
          while (!this.lifetime.closed && Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.revision > beforeRevision &&
              snapshot.state.inspection?.completedTick !== undefined &&
              snapshot.state.inspection.actorAddress === actor.address
            ) {
              break;
            }
            await this.lifetime.wait(this.pollIntervalMilliseconds);
          }
        }
      }
    }

    const inspectionTrigger =
      snapshot.state.phase === "embark" && !snapshot.state.partyPlanning?.rosterCandidates.some((hero) => hero.heroGuid !== undefined)
        ? { key: `preparation:${snapshot.state.expedition?.selectedQuestIndex ?? -1}`, tick: snapshot.state.lastTick }
        : snapshot.state.eventOverlay?.active === true
          ? {
            key: `event:${snapshot.state.eventOverlay.openedTick}`,
            tick: snapshot.state.eventOverlay.openedTick,
          }
          : snapshot.state.loot?.active === true
            ? {
              key: `loot:${snapshot.state.loot.openedTick}`,
              tick: snapshot.state.loot.openedTick,
            }
            : !snapshot.state.combatActive &&
              currentPhysicalArea(snapshot.state)?.areaKind === 1
              ? {
                key: `corridor-state:${currentPhysicalArea(snapshot.state)?.areaId}:${currentPhysicalTile(snapshot.state) ?? -1}`,
                tick:
                  snapshot.state.dungeonMap?.positionTick ??
                  snapshot.state.lastTick,
              }
              : snapshot.state.phase === "room" &&
                !snapshot.state.combatActive &&
                (snapshot.state.room?.propCount ?? 0) > 0
                ? {
                  key: `room-state:${snapshot.state.room?.observedTick ?? snapshot.revision}`,
                  tick: snapshot.state.room?.observedTick ?? snapshot.state.lastTick,
                }
                : snapshot.state.currentContext === "meal" ||
                  snapshot.state.currentContext === "camptarget"
                  ? {
                    key: `camp:${snapshot.state.currentContext}:${snapshot.state.camp?.phase ?? -1}:${snapshot.state.camp?.points ?? -1}`,
                    tick: snapshot.state.lastTick,
                  }
                  : snapshot.state.currentContext === "quest" ||
                    snapshot.state.currentContext === "questdone" ||
                    snapshot.state.currentContext === "raidfinish"
                    ? {
                      key: `quest:${snapshot.state.currentContext}:${snapshot.state.quest?.button ?? "unknown"}`,
                      tick: snapshot.state.lastTick,
                    }
                    : snapshot.state.currentContext === "results"
                      ? {
                        key: `results:${snapshot.state.results?.state ?? -1}`,
                        tick: snapshot.state.lastTick,
                      }
                      : undefined;
    if (
      inspectionTrigger !== undefined &&
      (snapshot.state.inspection?.completedTick ?? -1) < inspectionTrigger.tick &&
      !this.contextInspectionAttempts.has(inspectionTrigger.key)
    ) {
      this.contextInspectionAttempts.add(inspectionTrigger.key);
      const beforeRevision = snapshot.revision;
      const previousCompletedTick = snapshot.state.inspection?.completedTick;
      const acknowledgement = await this.game.send({
        kind: "inspect_state",
        args: {},
      });
      if (
        acknowledgement.status === "queued" ||
        acknowledgement.status === "accepted"
      ) {
        const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
        while (!this.lifetime.closed && Date.now() <= deadline) {
          snapshot = await this.game.refresh();
          if (
            snapshot.revision > beforeRevision &&
            snapshot.state.inspection?.completedTick !== undefined &&
            snapshot.state.inspection.completedTick !== previousCompletedTick
          ) {
            break;
          }
          await this.lifetime.wait(this.pollIntervalMilliseconds);
        }
      }
    }

    const roomObservationTick = snapshot.state.room?.observedTick;
    const mapCompletedTick = snapshot.state.dungeonMap?.completedTick;
    const mapNeedsRefresh =
      snapshot.state.phase === "room" &&
      !snapshot.state.combatActive &&
      (mapCompletedTick === undefined ||
        (roomObservationTick !== undefined && mapCompletedTick < roomObservationTick));
    if (mapNeedsRefresh) {
      const attemptKey = `room:${roomObservationTick ?? snapshot.revision}`;
      if (!this.mapInspectionAttempts.has(attemptKey)) {
        this.mapInspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const previousCompletedTick = snapshot.state.dungeonMap?.completedTick;
        const acknowledgement = await this.game.send({ kind: "inspect_map", args: {} });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
          while (!this.lifetime.closed && Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.revision > beforeRevision &&
              snapshot.state.dungeonMap?.completedTick !== undefined &&
              snapshot.state.dungeonMap.completedTick !== previousCompletedTick
            ) {
              break;
            }
            await this.lifetime.wait(this.pollIntervalMilliseconds);
          }
        }
      }
    }

    const navigation = snapshot.state.navigation;
    const map = snapshot.state.dungeonMap;
    if (
      !snapshot.state.combatActive &&
      navigation !== undefined &&
      map?.currentAreaId === navigation.toArea &&
      map.positionTick !== undefined &&
      (snapshot.state.room?.observedTick ?? -1) < map.positionTick
    ) {
      const attemptKey = `${navigation.toArea}:${map.positionTick}`;
      if (!this.arrivalInspectionAttempts.has(attemptKey)) {
        this.arrivalInspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const previousRoomTick = snapshot.state.room?.observedTick;
        const acknowledgement = await this.game.send({
          kind: "key_press",
          args: { sym: SDLK_d, mod: KMOD_LSHIFT },
        });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.settlementTimeoutMilliseconds;
          while (!this.lifetime.closed && Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.state.combatActive ||
              snapshot.state.phase === "event" ||
              snapshot.state.phase === "modal" ||
              snapshot.state.phase === "loot" ||
              (snapshot.revision > beforeRevision &&
                snapshot.state.room?.observedTick !== undefined &&
                snapshot.state.room.observedTick !== previousRoomTick) ||
              this.game.recordsAfter(beforeRevision, 2_000).some((record) =>
                /^(?:resting point: landing in the dungeon view|roomview enter:|tilestep: stop - prop\b|tilestep: no further movement .*\bmoved=1\b)/u.test(
                  record.message ?? "",
                ),
              )
            ) {
              break;
            }
            await this.lifetime.wait(this.pollIntervalMilliseconds);
          }
        }
        if (
          !snapshot.state.combatActive &&
          snapshot.state.phase !== "event" &&
          snapshot.state.phase !== "modal" &&
          snapshot.state.phase !== "loot" &&
          snapshot.state.room?.observedTick === previousRoomTick
        ) {
          const observeRevision = snapshot.revision;
          const observe = await this.game.send({
            kind: "key_press",
            args: { sym: SDLK_r, mod: 0 },
          });
          if (observe.status === "queued" || observe.status === "accepted") {
            const deadline = Date.now() + this.settlementTimeoutMilliseconds;
            while (!this.lifetime.closed && Date.now() <= deadline) {
              snapshot = await this.game.refresh();
              if (
                snapshot.revision > observeRevision &&
                snapshot.state.room?.observedTick !== undefined &&
                snapshot.state.room.observedTick !== previousRoomTick
              ) {
                break;
              }
              await this.lifetime.wait(this.pollIntervalMilliseconds);
            }
          }
        }
      }
    }
    return snapshot;
  }
}
