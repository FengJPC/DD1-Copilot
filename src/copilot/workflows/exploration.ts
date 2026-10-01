import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { roomPropHero } from "../identity.js";
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { KMOD_LSHIFT, MAP_DIRECTIONS, SDLK_HOME, SDLK_RETURN, SDLK_RIGHT, SDLK_a, SDLK_d, SDLK_i, SDLK_m, SDLK_r, SDLK_w, currentDecisionRoomId, currentPhysicalArea, currentPhysicalTile, delay, secretExitRoutes } from '../workflow-support.js';
import { inspectAfterDungeonInteraction } from './inspection.js';

export async function travelToRoom(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "travel_to_room" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const map = before.state.dungeonMap!;
  const currentRoomId = currentDecisionRoomId(before.state)!;
  const secretRoute = secretExitRoutes(before.state, currentRoomId).find(
    (route) => route.roomId === action.roomId,
  );
  const edge = secretRoute === undefined
    ? map.edges.find(
      (candidate) =>
        candidate.fromAreaId === currentRoomId &&
        candidate.toAreaId === action.roomId,
    )!
    : map.edges.find(
      (candidate) =>
        candidate.fromAreaId === currentRoomId &&
        candidate.corridorAreaId === secretRoute.corridorAreaId,
    )!;
  const destination = map.areas.find(
    (area) => area.areaId === action.roomId,
  )!;
  const direction = MAP_DIRECTIONS.find(
    (candidate) =>
      candidate.direction ===
      (secretRoute?.secretDirection ?? edge.direction),
  );
  if (direction === undefined) {
    return {
      outcome: "failure" as const,
      reason: `The map reported unsupported direction ${edge.direction}.`,
      snapshot: before,
    };
  }

  let current = before;
  if (current.state.currentContext !== "map") {
    const open = await context.executeStep(
      "open_raid_map",
      current,
      { kind: "key_press", args: { sym: SDLK_m, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.currentContext === "map" ||
          observations.some((record) =>
            /^mapreview open \(focus\)/u.test(record.message ?? ""),
          )
          ? { outcome: "success", reason: "The raid map became active." }
          : undefined,
    );
    steps.push(open.record);
    if (open.record.outcome !== "success") {
      return resultFromStep(open, "Opened the raid map.");
    }
    current = open.snapshot;
  }

  const home = await context.executeStep(
    "focus_current_room",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) =>
        /^mapnav home -> area=\d+ tile=\d+$/u.test(record.message ?? ""),
      )
        ? {
          outcome: "success",
          reason: "The map cursor returned to the party's current room.",
        }
        : undefined,
    1_500,
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") {
    return resultFromStep(home, "Focused the current room on the raid map.");
  }
  current = home.snapshot;

  const firstSelectionArea = secretRoute === undefined
    ? destination
    : map.areas.find(
      (area) => area.areaId === secretRoute.corridorAreaId,
    )!;
  const select = await context.executeStep(
    secretRoute === undefined
      ? `select_room_${action.roomId}`
      : `select_secret_door_${secretRoute.corridorAreaId}`,
    current,
    { kind: "key_press", args: { sym: direction.sym, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) =>
        new RegExp(
          `^mapnav room-step dir=${direction.direction} -> area=${firstSelectionArea.areaIndex} tile=\\d+$`,
          "u",
        ).test(record.message ?? ""),
      )
        ? {
          outcome: "success",
          reason:
            secretRoute === undefined
              ? `The map cursor selected room ${action.roomId} (${direction.name}).`
              : `The map cursor selected the secret door in ${secretRoute.corridorAreaId}.`,
        }
        : undefined,
    1_500,
  );
  steps.push(select.record);
  if (select.record.outcome !== "success") {
    return resultFromStep(select, `Selected room ${action.roomId}.`);
  }
  current = select.snapshot;

  if (secretRoute !== undefined) {
    const endpointDirection = MAP_DIRECTIONS.find(
      (candidate) => candidate.direction === secretRoute.endpointDirection,
    )!;
    const endpoint = await context.executeStep(
      `select_secret_exit_room_${action.roomId}`,
      current,
      { kind: "key_press", args: { sym: endpointDirection.sym, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(
            `^mapnav room-step dir=${endpointDirection.direction} -> area=${destination.areaIndex} tile=\\d+$`,
            "u",
          ).test(record.message ?? ""),
        )
          ? {
            outcome: "success",
            reason: `The map cursor selected secret-room exit ${action.roomId}.`,
          }
          : undefined,
      1_500,
    );
    steps.push(endpoint.record);
    if (endpoint.record.outcome !== "success") {
      return resultFromStep(endpoint, `Selected secret-room exit ${action.roomId}.`);
    }
    current = endpoint.snapshot;
  }

  const move = await context.executeStep(
    "confirm_map_move",
    current,
    {
      kind: "key_press",
      args: { sym: SDLK_RETURN, mod: 0 },
    },
    (_snapshot, observations) => {
      if (
        observations.some(
          (record) =>
            (record.event?.kind === "map_move_started" &&
              record.event.toArea === action.roomId) ||
            /^map-move: party started moving ->/u.test(record.message ?? ""),
        )
      ) {
        return {
          outcome: "success",
          reason: `The party started travelling ${direction.name} to room ${action.roomId}.`,
        };
      }
      if (
        observations.some((record) =>
          /^map-move: (?:move call faulted|no movement within window|gate refused|no door)/u.test(
            record.message ?? "",
          ),
        )
      ) {
        return { outcome: "failure", reason: "The game refused the map move." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(move.record);
  return resultFromStep(
    move,
    `Started automatic travel to the chosen room ${action.roomId}.`,
  );
}

export async function advanceCorridor(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  if (current.state.currentContext === "map") {
    const closeMap = await context.executeStep(
      "close_raid_map",
      current,
      { kind: "key_press", args: { sym: SDLK_i, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.currentContext !== "map" ||
          observations.some((record) =>
            /^mapreview auto-closed\b/u.test(record.message ?? ""),
          )
          ? { outcome: "success", reason: "The raid map closed." }
          : undefined,
    );
    steps.push(closeMap.record);
    if (closeMap.record.outcome !== "success") {
      return resultFromStep(closeMap, "Closed the raid map.");
    }
    current = closeMap.snapshot;
  }

  let stagnantAttempts = 0;
  for (let index = 0; index < 16; index += 1) {
    const area = currentPhysicalArea(current.state);
    const tile = currentPhysicalTile(current.state);
    if (area?.areaKind !== 1 || tile === undefined) {
      return {
        outcome: "success" as const,
        reason: "Corridor travel ended because the party entered another area.",
        snapshot: current,
      };
    }
    if (tile >= area.tileCount - 1) {
      return {
        outcome: "success" as const,
        reason: "The party reached the forward door.",
        snapshot: current,
      };
    }

    const step = await context.executeStep(
      `advance_corridor_from_tile_${tile}`,
      current,
      { kind: "key_press", args: { sym: SDLK_d, mod: KMOD_LSHIFT } },
      (snapshot, observations) => {
        if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
          return { outcome: "success", reason: "Combat interrupted corridor travel." };
        }
        if (
          observations.some(
            (record) => record.event?.kind === "tile_step_arrived",
          )
        ) {
          return { outcome: "success", reason: "The party advanced one corridor tile." };
        }
        if (
          observations.some((record) =>
            /^tilestep: refused .*trap|^tilestep: stop - prop\b|^tilestep: released .*parked short of the trap boundary\b/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "success", reason: "A corridor hazard or object stopped travel." };
        }
        if (
          snapshot.state.phase === "event" ||
          snapshot.state.phase === "modal" ||
          snapshot.state.phase === "loot" ||
          snapshot.state.currentContext === "event" ||
          snapshot.state.currentContext === "itemuse"
        ) {
          return { outcome: "success", reason: "A game event interrupted corridor travel." };
        }
        if (
          observations.some((record) =>
            /^tilestep: (?:no movement|refused .*past the door)|the party never moved/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "failure", reason: "The party could not advance." };
        }
        return undefined;
      },
      context.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    if (step.record.outcome !== "success") {
      return resultFromStep(step, "Advanced through the corridor.");
    }
    current = step.snapshot;

    const stoppedAtHazard = step.record.observations.some((record) =>
      /^tilestep: refused .*trap|^tilestep: stop - prop\b|^tilestep: released .*parked short of the trap boundary\b/u.test(
        record.message ?? "",
      ),
    );
    if (stoppedAtHazard) {
      return inspectAfterDungeonInteraction(context,
        current,
        steps,
        "Corridor travel stopped at an object or revealed trap and refreshed the available choices.",
      );
    }

    if (current.state.combatActive || current.state.phase === "combat") {
      return {
        outcome: "success" as const,
        reason: "Corridor travel stopped when combat began.",
        snapshot: current,
      };
    }
    if (
      current.state.phase === "event" ||
      current.state.phase === "modal" ||
      current.state.phase === "loot" ||
      current.state.currentContext === "event" ||
      current.state.currentContext === "itemuse" ||
      stoppedAtHazard
    ) {
      return {
        outcome: "success" as const,
        reason: "Corridor travel stopped for an event, object, or hazard.",
        snapshot: current,
      };
    }

    const arrival = step.record.observations.find(
      (record) => record.event?.kind === "tile_step_arrived",
    )?.event;
    if (arrival?.kind === "tile_step_arrived") {
      const plainTile = /^(?:第\d+格，共\d+格|Tile \d+ of \d+)[.。]?$/u;
      if (!plainTile.test(arrival.description.trim())) {
        return {
          outcome: "success" as const,
          reason: `Corridor travel stopped at: ${arrival.description}`,
          snapshot: current,
        };
      }
      if (!arrival.newArea && arrival.tile === tile) {
        stagnantAttempts += 1;
        if (stagnantAttempts >= 3) {
          return {
            outcome: "uncertain" as const,
            reason: "Three corridor steps ended on the same tile; movement needs reconciliation.",
            snapshot: current,
          };
        }
      } else {
        stagnantAttempts = 0;
      }
    }
    // The DLL verifies and, if needed, force-releases the held movement key
    // 250 ms after each tile step. Starting the next step immediately can
    // make that release cancel the new keydown; 300 ms keeps a small margin.
    await delay(300);
  }

  return {
    outcome: "uncertain" as const,
    reason: "Corridor travel exceeded the bounded 16-tile workflow.",
    snapshot: current,
  };
}

export async function enterRoom(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const raidFinishedDuringEntry = (snapshot: CombatLogSnapshot) =>
    snapshot.state.currentContext === "questdone" ||
    snapshot.state.currentContext === "raidfinish" ||
    snapshot.state.currentContext === "results";
  const previousAreaId = before.state.dungeonMap?.currentAreaId;
  const previousRoomTick = before.state.room?.observedTick;
  const step = await context.executeStep(
    "enter_forward_room",
    before,
    { kind: "key_press", args: { sym: SDLK_w, mod: 0 } },
    (snapshot, observations) => {
      if (raidFinishedDuringEntry(snapshot)) {
        return { outcome: "success", reason: "Entering the room completed the quest." };
      }
      const area = currentPhysicalArea(snapshot.state);
      if (
        area !== undefined &&
        snapshot.state.dungeonMap?.currentAreaId !== previousAreaId
      ) {
        return {
          outcome: "success",
          reason:
            area.areaKind === 0
              ? `The party entered room ${area.areaId}.`
              : `The party left the secret room for corridor ${area.areaId}.`,
        };
      }
      if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
        return { outcome: "success", reason: "Entering the room started combat." };
      }
      if (
        snapshot.state.room?.observedTick !== undefined &&
        snapshot.state.room.observedTick !== previousRoomTick
      ) {
        return { outcome: "success", reason: "The destination room was observed." };
      }
      if (
        observations.some((record) =>
          /^(?:roomview enter|agent-map: position area='roo)/u.test(
            record.message ?? "",
          ),
        )
      ) {
        return { outcome: "success", reason: "The party crossed the forward door." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  if (step.record.outcome !== "success") {
    return resultFromStep(step, "Entered the forward room.");
  }
  if (raidFinishedDuringEntry(step.snapshot)) {
    return resultFromStep(step, "Entered the forward room and completed the quest.");
  }
  if (step.snapshot.state.combatActive || step.snapshot.state.phase === "combat") {
    return resultFromStep(step, "Entered the forward room and combat began.");
  }

  const enteredRoomTick = step.snapshot.state.room?.observedTick;
  const advance = await context.executeStep(
    "advance_into_room",
    step.snapshot,
    { kind: "key_press", args: { sym: SDLK_d, mod: KMOD_LSHIFT } },
    (snapshot, observations) => {
      if (raidFinishedDuringEntry(snapshot)) {
        return { outcome: "success", reason: "Advancing into the room completed the quest." };
      }
      if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
        return { outcome: "success", reason: "Advancing into the room started combat." };
      }
      if (
        snapshot.state.room?.observedTick !== undefined &&
        snapshot.state.room.observedTick !== enteredRoomTick
      ) {
        return { outcome: "success", reason: "The party reached the room decision point." };
      }
      if (
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "modal" ||
        snapshot.state.phase === "loot"
      ) {
        return { outcome: "success", reason: "A room event interrupted entry movement." };
      }
      if (
        observations.some((record) =>
          /^(?:resting point: landing in the dungeon view|roomview enter:|tilestep: stop - prop\b|tilestep: no further movement .*\bmoved=1\b)/u.test(
            record.message ?? "",
          ),
        )
      ) {
        return { outcome: "success", reason: "The party advanced to the room decision point." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(advance.record);
  if (advance.record.outcome !== "success") {
    return resultFromStep(
      advance,
      "Crossed the door but could not verify arrival at the room decision point.",
    );
  }
  if (raidFinishedDuringEntry(advance.snapshot)) {
    return resultFromStep(advance, "Entered the forward room and completed the quest.");
  }
  if (advance.snapshot.state.combatActive || advance.snapshot.state.phase === "combat") {
    return resultFromStep(advance, "Entered the forward room and combat began.");
  }

  let current = advance.snapshot;
  if (
    current.state.phase !== "event" &&
    current.state.phase !== "modal" &&
    current.state.phase !== "loot" &&
    current.state.room?.observedTick === enteredRoomTick
  ) {
    const observe = await context.executeStep(
      "observe_entered_room",
      current,
      { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
      (snapshot, observations) => {
        if (raidFinishedDuringEntry(snapshot)) {
          return { outcome: "success", reason: "The entered room completed the quest." };
        }
        return (snapshot.state.room?.observedTick !== undefined &&
          snapshot.state.room.observedTick !== enteredRoomTick) ||
          observations.some((record) => /^roomview enter:/u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The entered room was observed." }
          : undefined;
      },
    );
    steps.push(observe.record);
    if (observe.record.outcome !== "success") {
      return resultFromStep(observe, "Entered the room but could not observe its contents.");
    }
    current = observe.snapshot;
    if (raidFinishedDuringEntry(current)) {
      return resultFromStep(observe, "Entered the forward room and completed the quest.");
    }
  }
  return inspectAfterDungeonInteraction(context,
    current,
    steps,
    "Entered the forward room and refreshed its interactables, inventory, and light.",
  );
}

export async function returnToPreviousRoom(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const previousAreaId = before.state.dungeonMap?.currentAreaId;
  const expectedRoomId = before.state.navigation?.fromArea;
  const step = await context.executeStep(
    "enter_previous_room",
    before,
    { kind: "key_press", args: { sym: SDLK_w, mod: 0 } },
    (snapshot, observations) => {
      const area = currentPhysicalArea(snapshot.state);
      if (
        area?.areaKind === 0 &&
        snapshot.state.dungeonMap?.currentAreaId !== previousAreaId
      ) {
        return {
          outcome: "success",
          reason:
            expectedRoomId === undefined || area.areaId === expectedRoomId
              ? `The party returned to room ${area.areaId}.`
              : `The party crossed the rear door into room ${area.areaId}.`,
        };
      }
      if (
        observations.some((record) =>
          /^agent-map: position area='roo/u.test(record.message ?? ""),
        )
      ) {
        return { outcome: "success", reason: "The party crossed the rear door." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  return resultFromStep(step, "Returned to the previous room.");
}

export async function approachRoomProp(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "approach_room_prop" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const original = before.state.room?.props?.find(
    (candidate) => candidate.propIndex === action.propIndex,
  )!;
  const movementCommand = {
    kind: "key_press",
    args: { sym: original.direction > 0 ? SDLK_d : SDLK_a, mod: 0 },
  };
  const acknowledgement = await context.game.send(movementCommand);
  if (
    acknowledgement.status === "rejected" ||
    acknowledgement.status === "unavailable" ||
    acknowledgement.status === "timeout"
  ) {
    const outcome =
      acknowledgement.status === "timeout"
        ? ("uncertain" as const)
        : ("failure" as const);
    steps.push({
      name: "approach_room_prop",
      sourceRevision: before.revision,
      finalRevision: before.revision,
      outcome,
      reason: acknowledgement.reason ?? `Movement was ${acknowledgement.status}.`,
      primitiveCommand: movementCommand,
      acknowledgement,
      observations: [],
    });
    return {
      outcome,
      reason: steps.at(-1)!.reason,
      snapshot: before,
    };
  }

  // A normal A/D tap has no reliable movement log. Let the game settle, then
  // inspect memory and use the changed prop distance as semantic evidence.
  await delay(350);
  const inspection = await context.executeStep(
    "inspect_after_prop_approach",
    before,
    { kind: "inspect_state", args: {} },
    (snapshot, observations) => {
      if (
        !observations.some(
          (record) => record.event?.kind === "agent_state_completed",
        )
      ) {
        return undefined;
      }
      const current = snapshot.state.room?.props?.find(
        (candidate) => candidate.propIndex === action.propIndex,
      );
      if (current === undefined || !current.active) {
        return { outcome: "success", reason: "The interactable is no longer active." };
      }
      if (current.reachable || current.distance < original.distance) {
        return {
          outcome: "success",
          reason: current.reachable
            ? "The interactable is now reachable."
            : `The interactable distance decreased ${original.distance} -> ${current.distance}.`,
        };
      }
      return {
        outcome: "failure",
        reason: "The verified interactable distance did not decrease.",
      };
    },
    context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push({
    name: "approach_room_prop",
    sourceRevision: before.revision,
    finalRevision: inspection.snapshot.revision,
    outcome: inspection.record.outcome,
    reason: inspection.record.reason,
    primitiveCommand: movementCommand,
    acknowledgement,
    observations: inspection.record.observations,
  });
  steps.push(inspection.record);
  return resultFromStep(inspection, "Approached the room interactable.");
}

export async function interactRoomProp(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "interact_room_prop" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const prop = before.state.room?.props?.find(
    (candidate) => candidate.propIndex === action.propIndex,
  )!;
  const hero = roomPropHero(before.state, action)!;
  if (prop.trap) {
    const disarm = await context.executeStep(
      "disarm_trap",
      before,
      {
        kind: "disarm_trap",
        args: { propIndex: action.propIndex, heroIndex: hero.sideIndex },
      },
      (_snapshot, observations) => {
        const result = observations.find(
          (record) => record.event?.kind === "trap_result",
        )?.event;
        if (result?.kind !== "trap_result") return undefined;
        if (result.outcome === "disarmed") {
          return {
            outcome: "success",
            reason: `${hero.name} disarmed ${prop.name} (${hero.trapDisarmChance ?? "unknown"}% chance).`,
          };
        }
        if (result.outcome === "triggered") {
          return {
            outcome: "success",
            reason: `${hero.name} triggered ${prop.name}: HP ${result.hpDelta}, stress ${result.stressDelta}.`,
          };
        }
        return {
          outcome: "failure",
          reason: `The game returned an unknown result for ${prop.name}.`,
        };
      },
      Math.max(context.settlementTimeoutMilliseconds * 6, 10_000),
    );
    steps.push(disarm.record);
    if (disarm.record.outcome !== "success") {
      return resultFromStep(disarm, `Resolved ${prop.name}.`);
    }
    return inspectAfterDungeonInteraction(context,
      disarm.snapshot,
      steps,
      disarm.record.reason,
    );
  }
  let current = before;
  const selectHero = await context.executeStep(
    "select_room_prop_hero_by_guid",
    current,
    { kind: "select_raid_hero", args: { heroGuid: action.heroGuid } },
    (_snapshot, observations) =>
      observations.some((record) =>
        new RegExp(`^agent-raid: selected hero_guid=${action.heroGuid}\\b`, "u").test(
          record.message ?? "",
        ),
      )
        ? { outcome: "success", reason: `${hero.name} was selected for the interaction.` }
        : undefined,
    1_500,
  );
  steps.push(selectHero.record);
  if (selectHero.record.outcome !== "success") {
    return resultFromStep(selectHero, `Selected ${hero.name} for ${prop.name}.`);
  }
  current = selectHero.snapshot;
  if (current.state.currentContext !== "room") {
    const open = await context.executeStep(
      "open_room_view",
      current,
      { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.currentContext === "room" ||
          observations.some((record) => /^roomview enter:/u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The dungeon room view opened." }
          : undefined,
    );
    steps.push(open.record);
    if (open.record.outcome !== "success") return resultFromStep(open, "Opened room view.");
    current = open.snapshot;
  }

  const targetRow =
    (current.state.room?.partyCount ?? 0) +
    (current.state.room?.enemyCount ?? 0) +
    action.propIndex;
  const home = await context.executeStep(
    "focus_first_room_row",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) => /^roomview row 0\//u.test(record.message ?? ""))
        ? { outcome: "success", reason: "The first room row is focused." }
        : undefined,
    1_500,
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") return resultFromStep(home, "Focused room rows.");
  current = home.snapshot;

  for (let row = 1; row <= targetRow; row += 1) {
    const move = await context.executeStep(
      `focus_room_row_${row}`,
      current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(`^roomview row ${row}\\/`, "u").test(record.message ?? ""),
        )
          ? { outcome: "success", reason: `Room row ${row} is focused.` }
          : undefined,
      1_500,
    );
    steps.push(move.record);
    if (move.record.outcome !== "success") return resultFromStep(move, "Focused the interactable.");
    current = move.snapshot;
  }

  const activate = await context.executeStep(
    "activate_room_prop",
    current,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (snapshot, observations) => {
      const interaction = observations
        .map((record) =>
          /^curio: InteractWithProp returned \d+ .* state (\d+) -> (\d+),/u.exec(
            record.message ?? "",
          ),
        )
        .find((match) => match !== null);
      if (
        snapshot.state.eventOverlay?.active === true ||
        snapshot.state.loot?.active === true ||
        (interaction !== undefined && interaction[1] !== interaction[2]) ||
        observations.some((record) => /^trap:/u.test(record.message ?? ""))
      ) {
        return { outcome: "success", reason: `Interaction with ${prop.name} started.` };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(activate.record);
  return resultFromStep(activate, `Interacted with ${prop.name}.`);
}
