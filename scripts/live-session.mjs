import { summarizeActionRecord as summarizeAction, summarizeCombatTransition } from "../dist/copilot/presentation.js";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { NamedPipeCommandTransport } from "../dist/command/transport.js";
import { CampaignMemoryStore } from "../dist/copilot/campaign-memory.js";
import { CopilotEngine } from "../dist/copilot/engine.js";
import { TacticalStateProjector } from "../dist/copilot/tactical-projector.js";
import { LocalGameGateway } from "../dist/copilot/local-game-gateway.js";
import {
  observeLiveActionState,
  resolveLiveExpectedRevision,
} from "../dist/copilot/live-request.js";
import { CombatLogSource } from "../dist/live/combat-log-source.js";

const logPath = process.env.DD1_BLINDEST_LOG;
const pipePath = process.env.DD1_COMMAND_PIPE;

if (!logPath || !pipePath) {
  throw new Error("DD1_BLINDEST_LOG and DD1_COMMAND_PIPE must be configured.");
}

const engine = new CopilotEngine(
  new LocalGameGateway(
    new CombatLogSource(logPath),
    new NamedPipeCommandTransport(pipePath, 3_000),
  ),
);
const tacticalProjector = new TacticalStateProjector();
const memory = CampaignMemoryStore.fromEnvironment();
let lastSummaryRevision;
let mapBaselineDelivered = false;
let liveStatePrimed = false;

// Codex keeps this helper alive through a pseudo terminal. Raw mode prevents
// each JSON request from being echoed back with terminal wrapping and ANSI
// cursor controls, which otherwise duplicates input in the model context.
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(id, payload) {
  process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`);
}

function summarizeCombatant(combatant) {
  if (combatant === undefined) return undefined;
  return {
    targetGuid: combatant.actorGuid,
    heroGuid: combatant.heroGuid,
    side: combatant.side,
    slot: combatant.slot,
    slotEnd: combatant.slotEnd,
    name: combatant.name,
    currentHp: combatant.currentHp,
    maxHp: combatant.maxHp,
    stress: combatant.stress,
    conditions: combatant.conditions,
  };
}

function summarizeTarget(target) {
  if (target === undefined) return undefined;
  return {
    side: target.side,
    slot: target.slot,
    slotEnd: target.slotEnd,
    name: target.name,
    currentHp: target.currentHp,
    maxHp: target.maxHp,
    conditions: target.conditions,
  };
}

function summarizeDecision(decision, inCombat) {
  if (decision === undefined) return undefined;
  if (inCombat) {
    return {
      kind: decision.kind,
      selectedSkill: decision.selectedSkill,
      currentTarget: summarizeTarget(decision.currentTarget),
    };
  }
  return {
    kind: decision.kind,
    prompt: decision.prompt,
    building: decision.building,
    details: decision.details,
    actor: summarizeCombatant(decision.actor),
    roster: decision.roster,
    party: decision.party,
    wallet: decision.wallet,
    bag: decision.bag,
    selectedSkill: decision.selectedSkill,
    currentTarget: summarizeTarget(decision.currentTarget),
    skills: decision.skills?.map((skill) => ({
      skillSlot: skill.skillSlot,
      skillElementId: skill.skillElementId ?? skill.elementId,
      name: skill.name,
    })),
    targets: decision.targets?.map(summarizeTarget),
    options: decision.options,
  };
}

function summarizeMap(map, includeFullMap) {
  if (map === undefined) return undefined;
  if (includeFullMap) return map;
  return {
    currentAreaId: map.currentAreaId,
    currentRoomId: map.currentRoomId,
    positionTick: map.positionTick,
    visitedAreaIds: map.areas
      ?.filter((area) => area.visited)
      .map((area) => area.areaId),
  };
}

function summarizeState(state, includeFullMap = false) {
  if (Array.isArray(state.changes)) {
    return {
      revision: state.revision,
      observedAt: state.observedAt,
      afterRevision: state.afterRevision,
      phase: state.phase,
      context: state.context,
      truncated: state.truncated,
      resyncRequired: state.resyncRequired,
      decision: summarizeDecision(state.decision, false),
      advisories: state.advisories,
      changes: state.changes.slice(-16),
      mapUpdate: state.mapUpdate,
      diagnostics: state.diagnostics,
    };
  }
  if (
    state.combat !== undefined &&
    state.combat.active !== false &&
    (state.phase === "combat" || state.phase === "targeting")
  ) {
    return tacticalProjector.project(state);
  }
  tacticalProjector.reset();
  const inActiveCombat =
    state.combat !== undefined &&
    state.combat.active !== false &&
    (state.phase === "combat" || state.phase === "targeting");
  return {
    revision: state.revision,
    observedAt: state.observedAt,
    phase: state.phase,
    context: state.context,
    decision: summarizeDecision(state.decision, inActiveCombat),
    room: state.room,
    party: state.party?.map(summarizeCombatant),
    inventory: state.inventory,
    light: state.light,
    advisories: state.advisories,
    camp: state.camp,
    quest: state.quest,
    results: state.results,
    event: state.event,
    loot: state.loot,
    map: summarizeMap(state.map, includeFullMap),
    navigation: state.navigation,
    combat:
      state.combat === undefined
        ? undefined
        : {
            actor: summarizeCombatant(state.combat.actor),
            party: state.combat.party.map(summarizeCombatant),
            enemies: state.combat.enemies.map(summarizeCombatant),
            skills: state.combat.skills.map((skill) => ({
              skillSlot: skill.skillSlot,
      skillElementId: skill.skillElementId ?? skill.elementId,
              name: skill.name,
            })),
            recentResults: state.combat.recentResults?.slice(-4),
          },
    recentEvents: state.recentEvents?.slice(-8),
    diagnostics: state.diagnostics,
  };
}

function summarizeForReply(state, forceFullMap = false) {
  const includeFullMap =
    state?.map !== undefined && (forceFullMap || !mapBaselineDelivered);
  const summary = summarizeState(state, includeFullMap);
  if (includeFullMap) mapBaselineDelivered = true;
  return summary;
}


const COMBAT_DECISION_ACTIONS = new Set(["use_skill", "pass_turn", "move_hero"]);



reply("startup", { ready: true, memory: memory.getStatus() });

for await (const line of input) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    reply("parse", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    continue;
  }

  const id = String(request.id ?? "request");
  const startedAt = Date.now();
  try {
    if (request.op === "state") {
      const autoDelta =
        request.project === "summary" &&
        request.mode === undefined &&
        lastSummaryRevision !== undefined;
      const mode = request.mode === "full"
          ? "full"
          : request.mode === "delta"
            ? "delta"
            : autoDelta
              ? "delta"
              : "compact";
      const state = await engine.getState(
        mode,
        Number(request.sinceRevision ?? (autoDelta ? lastSummaryRevision : 0)),
      );
      memory.observeState(state);
      const projected =
        request.project === "summary"
          ? summarizeForReply(state, request.includeMap === true)
          : state;
      if (request.project === "summary" && projected?.available === true) {
        memory.observeTactical(projected);
      }
      if (request.project === "summary") lastSummaryRevision = state.revision;
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        mode,
        state: projected,
      });
      continue;
    }

    if (request.op === "refresh") {
      const mode =
        request.mode === "full"
          ? "full"
          : request.mode === "delta"
            ? "delta"
            : "compact";
      const state = await engine.forceRefresh(
        mode,
        Number(request.sinceRevision ?? 0),
        request.includeMap === true,
      );
      liveStatePrimed = true;
      memory.observeState(state);
      const projected =
        request.project === "summary"
          ? summarizeForReply(state, request.includeMap === true)
          : state;
      if (request.project === "summary") lastSummaryRevision = state.revision;
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        mode,
        state: projected,
      });
      continue;
    }

    if (request.op === "act") {
      const liveState = await observeLiveActionState(engine, liveStatePrimed);
      liveStatePrimed = true;
      const currentRevision =
        request.expectedRevision === undefined || request.expectedRevision === null
          ? liveState.revision
          : 0;
      const action = await engine.act({
        requestId: String(request.requestId ?? id),
        expectedRevision: resolveLiveExpectedRevision(
          request.expectedRevision,
          currentRevision,
        ),
        action: request.action,
        rationale: request.rationale === undefined ? undefined : String(request.rationale),
      });
      memory.recordAction(action);
      reply(id, { ok: true, elapsedMs: Date.now() - startedAt, action });
      continue;
    }

    if (request.op === "act_current") {
      const state = await observeLiveActionState(engine, liveStatePrimed);
      liveStatePrimed = true;
      memory.observeState(state);
      const action = await engine.act({
        requestId: String(request.requestId ?? id),
        expectedRevision: state.revision,
        action: request.action,
        rationale: request.rationale === undefined ? undefined : String(request.rationale),
      });
      memory.recordAction(action);
      const shouldWait =
        request.waitForNextDecision !== false &&
        action.outcome === "success" &&
        COMBAT_DECISION_ACTIONS.has(action.action.kind);
      const wait = shouldWait
        ? await engine.waitForNextCombatDecision(
            Math.min(Number(request.waitTimeoutMilliseconds ?? 30_000), 30_000),
          )
        : undefined;
      const nextState =
        wait !== undefined || action.outcome === "uncertain"
          ? await engine.getState("compact", 0)
          : undefined;
      if (nextState !== undefined) memory.observeState(nextState);
      const nextDecision =
        wait?.status === "ready" && nextState !== undefined
          ? summarizeForReply(nextState)
          : undefined;
      if (nextDecision?.available === true) memory.observeTactical(nextDecision);
      const reconciled =
        (wait?.status === "timeout" || action.outcome === "uncertain") &&
        nextState !== undefined
          ? summarizeForReply(nextState)
          : undefined;
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        source: {
          revision: state.revision,
          phase: state.phase,
          context: state.context,
        },
        action: summarizeAction(action),
        transition: wait === undefined ? undefined : summarizeCombatTransition(wait),
        nextDecision,
        nextState:
          wait?.status === "combat_ended" && nextState !== undefined
            ? summarizeForReply(nextState)
            : undefined,
        reconciled,
      });
      continue;
    }

    if (request.op === "briefing") {
      const briefing = await engine.getBriefing(
        request.scope === "session" ? "session" : "recent",
      );
      reply(id, { ok: true, elapsedMs: Date.now() - startedAt, briefing });
      continue;
    }

    if (request.op === "resume") {
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        memory:
          request.detail === "full"
            ? memory.getResumePacket()
            : memory.getCampaignOverview(),
      });
      continue;
    }

    if (request.op === "hero_memory") {
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        memory: memory.getHeroMemory(Number(request.heroGuid), {
          observations: Number(request.observationLimit ?? 8),
          reflections: Number(request.reflectionLimit ?? 8),
        }),
      });
      continue;
    }

    if (request.op === "memory_status") {
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        memory: memory.getStatus(),
      });
      continue;
    }

    if (request.op === "reflect") {
      const reflection = memory.addReflection(request.reflection ?? {});
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        reflection,
      });
      continue;
    }

    if (request.op === "export_memory") {
      const outputDirectory = String(
        request.outputDirectory ??
          resolve("runs", "campaign-memory", memory.campaignId),
      );
      reply(id, {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        export: memory.exportMarkdown(outputDirectory),
      });
      continue;
    }

    if (request.op === "stop") {
      memory.close();
      reply(id, { ok: true, stopped: true });
      input.close();
      break;
    }

    reply(id, { ok: false, error: `Unknown operation: ${String(request.op)}` });
  } catch (error) {
    reply(id, {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}
