import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';
import { parseFraction } from '../reducer-support.js';

export function reduceCombat(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "hero_recruited": {
      const pending = state.recruitment?.pending;
      next.buildingHeroes = state.buildingHeroes
        .filter(
          (hero) =>
            pending === undefined ||
            (hero.heroAddress !== pending.heroAddress && hero.slot !== pending.slot),
        )
        .map((hero, row) => ({ ...hero, row }));
      next.recruitment = {
        rosterCount: event.rosterCount,
        rosterCapacity:
          state.recruitment?.rosterCapacity ?? event.rosterCount,
      };
      break;
    }
    case "hero_observed":
      next.focusedHero = {
        heroAddress: event.heroAddress,
        classAddress: event.classAddress,
        name: event.name,
        heroClass: event.heroClass,
      };
      break;
    case "hero_rank_observed":
      if (state.focusedHero !== undefined) {
        next.focusedHero = {
          ...state.focusedHero,
          xp: event.xp,
          level: event.level,
        };
      }
      break;
    case "roster_hero_observed": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        rosterCandidates: [
          ...planning.rosterCandidates.filter(
            (hero) => hero.entryAddress !== event.entryAddress,
          ),
          {
            row: event.row,
            heroGuid: event.heroGuid,
            entryAddress: event.entryAddress,
            name: event.name,
            state: event.state,
            building: event.building,
            missing: event.missing,
          },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "roster_picker_ready": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        picker: {
          heroCount: event.heroCount,
          selectedRow: event.selectedRow,
          pickSlot: event.pickSlot,
        },
      };
      break;
    }
    case "loading_continue_ready":
      next.phase = "loading";
      break;
    case "tile_step_arrived":
      if (state.navigation !== undefined) {
        next.navigation = {
          ...state.navigation,
          currentTile: event.tile,
          description: event.description,
        };
      }
      if (state.dungeonMap !== undefined) {
        const currentAreaId = state.dungeonMap.currentAreaId;
        next.dungeonMap = {
          ...state.dungeonMap,
          positionTick: event.tick,
          areas: state.dungeonMap.areas.map((area) =>
            area.areaId !== currentAreaId
              ? area
              : {
                ...area,
                tiles: area.tiles.map((tile) => ({
                  ...tile,
                  current: tile.tileIndex === event.tile,
                  visited: tile.visited || tile.tileIndex === event.tile,
                })),
              },
          ),
        };
      }
      break;
    case "combat_started":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.selectedSkill = undefined;
      next.lastObservedSkill = undefined;
      next.targets = [];
      next.recentResults = [];
      next.recentBuffs = [];
      next.combatants = [];
      next.combatActions = [];
      next.inspection = undefined;
      break;
    case "combat_ended":
      next.combatActive = false;
      next.combatEndCandidate = true;
      if (state.circusCombat !== undefined) {
        next.circusCombat = { ...state.circusCombat, active: false, pickOpen: false };
      }
      break;
    case "actor_changed":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.currentActor = {
        address: event.actorAddress,
        name: event.name,
        heroClass: event.heroClass,
        currentHp: event.currentHp,
        maxHp: event.maxHp,
        stress: event.stress,
        maxStress: event.maxStress,
        turnTick: event.tick,
      };
      next.selectedSkill = undefined;
      next.lastObservedSkill = undefined;
      next.currentTarget = undefined;
      next.targets = [];
      next.combatActions = [];
      next.inspection = undefined;
      break;
    case "skill_observed":
      next.lastObservedSkill = { id: event.skillId, name: event.name };
      break;
    case "skill_armed":
      next.selectedSkill =
        state.lastObservedSkill?.name === event.name
          ? state.lastObservedSkill
          : { id: "unknown", name: event.name };
      next.phase = "targeting";
      next.currentTarget = undefined;
      next.targets = [];
      break;
    case "target_preview":
      next.phase = "targeting";
      next.currentTarget = event;
      next.targets = [
        ...state.targets.filter(
          (target) => target.side !== event.side || target.slot !== event.slot,
        ),
        event,
      ];
      break;
    case "combat_result":
      next.recentResults = [...state.recentResults, event].slice(-50);
      break;
    case "combat_buff":
      next.recentBuffs = [...state.recentBuffs, event].slice(-50);
      break;
    case "combatant_observed": {
      const health = parseFraction(event.healthText);
      const stress = parseFraction(event.stressText);
      next.combatants = [
        ...state.combatants.filter(
          (combatant) => combatant.actorAddress !== event.actorAddress,
        ),
        {
          side: event.side,
          sideIndex: event.sideIndex,
          slot: event.slot,
          slotEnd: event.slotEnd,
          actorAddress: event.actorAddress,
          ...(event.actorGuid === undefined ? {} : { actorGuid: event.actorGuid }),
          ...(event.heroGuid === undefined ? {} : { heroGuid: event.heroGuid }),
          active: event.active,
          name: event.name,
          ...(health === undefined
            ? {}
            : { currentHp: health.current, maxHp: health.maximum }),
          ...(stress === undefined
            ? {}
            : { stress: stress.current, maxStress: stress.maximum }),
          conditions: event.conditions,
          details: [],
          resists: [],
          quirks: [],
          diseases: [],
        },
      ].sort((left, right) => {
        if (left.side !== right.side) return left.side === "party" ? -1 : 1;
        return left.slot - right.slot;
      });
      // A structured inspection reads the game's active flag directly.  It is
      // stronger evidence than the compact heroswap line, which is also used
      // for ordinary portrait focus changes.  Use it to recover a missed turn
      // handoff without teaching the parser to guess from focus-only logs.
      if (
        state.combatActive &&
        event.side === "party" &&
        event.active &&
        state.currentActor?.address !== event.actorAddress
      ) {
        const separator = event.name.lastIndexOf(", ");
        next.phase = "combat";
        next.combatEndCandidate = false;
        next.currentActor = {
          address: event.actorAddress,
          name: separator < 0 ? event.name : event.name.slice(0, separator),
          heroClass: separator < 0 ? "" : event.name.slice(separator + 2),
          currentHp: health?.current ?? 0,
          maxHp: health?.maximum ?? 0,
          stress: stress?.current ?? 0,
          maxStress: stress?.maximum ?? 200,
          turnTick: event.tick,
        };
        next.selectedSkill = undefined;
        next.lastObservedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
        next.combatActions = [];
        next.inspection = undefined;
      }
      break;
    }
    case "actor_detail_observed":
      next.combatants = state.combatants.map((combatant) => {
        if (combatant.actorAddress !== event.actorAddress) return combatant;
        const field =
          event.category === "resist"
            ? "resists"
            : event.category === "quirk"
              ? "quirks"
              : event.category === "disease"
                ? "diseases"
                : "details";
        const lines = [...combatant[field]];
        lines[event.line] = event.text;
        return { ...combatant, [field]: lines };
      });
      break;
    case "combat_action_observed":
      next.combatActions = [
        ...state.combatActions.filter(
          (action) => action.actionIndex !== event.actionIndex,
        ),
        {
          kind: event.actionKind,
          actionIndex: event.actionIndex,
          ...(event.skillSlot === undefined
            ? {}
            : { skillSlot: event.skillSlot }),
          elementId: event.elementId,
          name: event.name,
          details: [],
        },
      ].sort((left, right) => left.actionIndex - right.actionIndex);
      break;
    case "skill_detail_observed":
      next.combatActions = state.combatActions.map((action) => {
        if (action.skillSlot !== event.skillSlot) return action;
        const details = [...action.details];
        details[event.line] = event.text;
        return { ...action, details };
      });
      break;
    case "enemy_count_changed":
      if (event.current === 0) {
        next.combatEndCandidate = true;
        next.phase = "post_combat";
        next.selectedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
      }
      break;
    default: return false;
  }
  return true;
}
