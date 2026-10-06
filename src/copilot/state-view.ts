import type {
  CombatLogSnapshot
} from "../live/combat-log-source.js";
import { buildDecision } from './decision.js';
import { buildingDetailsView } from './town-availability.js';
import type { PendingCombatTransition } from './execution-types.js';
import { filterCopilotRecords } from "./filter.js";
import { currentActorView } from "./identity.js";
import type {
  GameGateway
} from "./types.js";
import { currentDecisionRoomId, MAP_EVENT_KINDS, roomPropDisplayName, stateAdvisories } from './workflow-support.js';

export function projectState(snapshot: CombatLogSnapshot, mode: 'compact' | 'delta' | 'full', afterRevision: number, recordsAfter: GameGateway['recordsAfter'], pendingCombatTransition?: PendingCombatTransition) {
  const decision = buildDecision(snapshot.state, pendingCombatTransition);
  const advisories = stateAdvisories(snapshot.state);
  const earliestBufferedRevision =
    snapshot.source.earliestBufferedRevision ?? snapshot.revision;
  const requestedRecords = recordsAfter(
    mode === "compact"
      ? Math.max(0, snapshot.revision - 120)
      : afterRevision,
    // Read the whole retained window before filtering. A noisy loading screen
    // can emit more than 500 raw lines while containing only one meaningful
    // state transition; limiting first would silently drop that transition.
    mode === "full" || mode === "delta" ? 2_000 : 120,
  );
  const filtered = filterCopilotRecords(requestedRecords, {
    // Unknown-line samples are useful while developing parsers, but they are
    // expensive and distracting in the model's normal play loop. Full mode
    // remains the explicit diagnostics escape hatch.
    unclassifiedSampleLimit: mode === "full" ? 20 : 0,
  });

  const compactRecords = filtered.records.map((record) => {
    if (record.event === undefined) return record;
    const { message: _message, ...withoutDuplicateMessage } = record;
    return withoutDuplicateMessage;
  });
  const mapChanged = requestedRecords.some(
    (record) =>
      record.event !== undefined && MAP_EVENT_KINDS.has(record.event.kind),
  );
  const modelRecords = compactRecords.filter(
    (record) =>
      record.event === undefined || !MAP_EVENT_KINDS.has(record.event.kind),
  );
  const mapUpdate =
    mapChanged && snapshot.state.dungeonMap !== undefined
      ? {
        currentAreaId: snapshot.state.dungeonMap.currentAreaId,
        currentRoomId: currentDecisionRoomId(snapshot.state),
        visitedAreaIds: snapshot.state.dungeonMap.areas
          .filter((area) => area.visited)
          .map((area) => area.areaId),
      }
      : undefined;

  if (mode === "full") {
    return {
      revision: snapshot.revision,
      observedAt: snapshot.observedAt,
      afterRevision,
      earliestBufferedRevision,
      truncated: afterRevision + 1 < earliestBufferedRevision,
      state: snapshot.state,
      source: snapshot.source,
      records: requestedRecords,
      filterPreview: filtered,
      advisories,
      decision,
    };
  }
  if (mode === "delta") {
    const truncated = afterRevision + 1 < earliestBufferedRevision;
    return {
      revision: snapshot.revision,
      observedAt: snapshot.observedAt,
      afterRevision,
      earliestBufferedRevision,
      truncated,
      resyncRequired: truncated,
      phase: snapshot.state.phase,
      context: snapshot.state.currentContext,
      changes: modelRecords,
      mapUpdate,
      diagnostics: {
        unclassifiedCount: filtered.unclassified.count,
        suppressedCount: filtered.suppressed.count,
      },
      advisories,
      decision,
    };
  }
  const buildingRelevant =
    snapshot.state.phase === "building" ||
    (snapshot.state.phase === "modal" &&
      snapshot.state.modalSourcePhase === 'building');
  const townRelevant = snapshot.state.phase === "town" || buildingRelevant;
  const combatRelevant =
    snapshot.state.phase === "combat" ||
    snapshot.state.phase === "targeting" ||
    snapshot.state.phase === "loot" ||
    snapshot.state.phase === "post_combat";
  return {
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
    phase: snapshot.state.phase,
    context: snapshot.state.currentContext,
    building: buildingRelevant ? snapshot.state.currentBuilding : undefined,
    decision,
    advisories,
    town: townRelevant
      ? {
        map: snapshot.state.townMap,
        wallet: snapshot.state.townWallet,
        locations: snapshot.state.townLocations,
      }
      : undefined,
    buildingDetails: buildingRelevant ? buildingDetailsView(snapshot.state) : undefined,
    buildingHeroes: buildingRelevant
      ? snapshot.state.buildingHeroes
      : undefined,
    recruitment: buildingRelevant
      ? snapshot.state.recruitment
      : undefined,
    focusedHero: buildingRelevant ? snapshot.state.focusedHero : undefined,
    activeTutorial: snapshot.state.activeTutorial,
    activeDialog: snapshot.state.activeDialog,
    circus: snapshot.state.phase === "circus" ? snapshot.state.circus : undefined,
    circusCombat: snapshot.state.circusCombat?.active === true ? snapshot.state.circusCombat : undefined,
    expedition:
      snapshot.state.phase === "embark" ||
        snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && ['embark', 'provision'].includes(snapshot.state.modalSourcePhase ?? ''))
        ? snapshot.state.expedition
        : undefined,
    partyPlanning:
      snapshot.state.phase === "embark" ||
        snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && ['embark', 'provision'].includes(snapshot.state.modalSourcePhase ?? ''))
        ? snapshot.state.partyPlanning
        : undefined,
    provisioning:
      snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && snapshot.state.modalSourcePhase === 'provision')
        ? {
          gold: snapshot.state.provisioning?.gold,
          shards: snapshot.state.provisioning?.shards,
          bagTotal: snapshot.state.provisioning?.bagTotal,
          bag: (snapshot.state.provisioning?.items ?? []).filter(
            (item) => item.section === 1 && item.amount > 0,
          ),
        }
        : undefined,
    room:
      snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
        ? snapshot.state.room === undefined
          ? undefined
          : {
            ...snapshot.state.room,
            props: snapshot.state.room.props?.map((prop) => ({
              ...prop,
              name: roomPropDisplayName(prop.name),
            })),
          }
        : undefined,
    party:
      snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
        ? snapshot.state.combatants.filter((combatant) => combatant.side === "party")
        : undefined,
    inventory:
      snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
        ? {
          capacity: snapshot.state.inventoryInfo,
          items: snapshot.state.inventory,
        }
        : undefined,
    light: snapshot.state.light,
    camp: snapshot.state.camp?.phase ? snapshot.state.camp : undefined,
    quest: snapshot.state.quest,
    results: snapshot.state.results,
    event:
      snapshot.state.eventOverlay?.active === true
        ? snapshot.state.eventOverlay
        : undefined,
    loot:
      snapshot.state.loot?.active === true ? snapshot.state.loot : undefined,
    map:
      snapshot.state.phase === "room" || snapshot.state.phase === "traveling"
        ? snapshot.state.dungeonMap === undefined
          ? undefined
          : {
            ...snapshot.state.dungeonMap,
            currentRoomId: currentDecisionRoomId(snapshot.state),
          }
        : undefined,
    navigation:
      snapshot.state.phase === "traveling"
        ? snapshot.state.navigation
        : undefined,
    combat: combatRelevant
      ? {
        active: snapshot.state.combatActive,
        actor: snapshot.state.combatActive
          ? currentActorView(snapshot.state)
          : undefined,
        party: snapshot.state.combatants.filter(
          (combatant) => combatant.side === "party",
        ),
        enemies: snapshot.state.combatants.filter(
          (combatant) => combatant.side === "enemy",
        ),
        skills: snapshot.state.combatActive
          ? snapshot.state.combatActions.filter(
            (action) => action.kind === "skill",
          )
          : [],
        selectedSkill: snapshot.state.combatActive
          ? snapshot.state.selectedSkill
          : undefined,
        currentTarget:
          !snapshot.state.combatActive || snapshot.state.currentTarget === undefined
            ? undefined
            : (({ raw: _raw, ...target }) => target)(
              snapshot.state.currentTarget,
            ),
        recentResults: snapshot.state.recentResults
          .slice(-8)
          .map(({ raw: _raw, ...result }) => result),
        recentBuffs: snapshot.state.recentBuffs
          .slice(-8)
          .map(({ raw: _raw, ...buff }) => buff),
        inspection: snapshot.state.inspection,
      }
      : undefined,
    recentEvents: modelRecords
      .filter((record) => record.importance === "critical")
      .slice(-6),
    diagnostics: {
      unclassifiedCount: filtered.unclassified.count,
      suppressedCount: filtered.suppressed.count,
    },
  };
}
