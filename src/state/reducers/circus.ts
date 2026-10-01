import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceCircus(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "circus_snapshot_started":
      next.phase = "circus";
      next.circus = {
        rowCount: event.rowCount, slotCount: event.slotCount, complete: false,
        contestants: [], slots: [],
      };
      break;
    case "circus_contestant_observed": {
      const circus = state.circus ?? { rowCount: 0, slotCount: 4, complete: false, contestants: [], slots: [] };
      next.circus = {
        ...circus,
        contestants: [...circus.contestants.filter((row) => row.row !== event.row), {
          row: event.row, heroAddress: event.heroAddress, name: event.name, heroClass: event.heroClass,
          inLineup: event.inLineup, dlcLocked: event.dlcLocked,
        }].sort((a, b) => a.row - b.row),
      };
      break;
    }
    case "circus_slot_observed": {
      const circus = state.circus ?? { rowCount: 0, slotCount: 4, complete: false, contestants: [], slots: [] };
      next.circus = {
        ...circus,
        slots: [...circus.slots.filter((row) => row.slot !== event.slot), {
          slot: event.slot, rank: event.rank,
          ...(event.heroAddress === undefined ? {} : { heroAddress: event.heroAddress }),
          name: event.name, heroClass: event.heroClass,
        }].sort((a, b) => a.slot - b.slot),
      };
      break;
    }
    case "circus_snapshot_completed":
      if (state.circus !== undefined) next.circus = { ...state.circus, complete: true };
      break;
    case "circus_assignment_observed": {
      if (!event.observed || event.slot < 0 || state.circus === undefined) break;
      const contestant = state.circus.contestants.find((row) => row.heroAddress === event.heroAddress);
      if (contestant === undefined) break;
      const slots = [...state.circus.slots.filter(
        (row) => row.slot !== event.slot && row.heroAddress !== event.heroAddress,
      ), {
        slot: event.slot, rank: state.circus.slotCount - event.slot, heroAddress: event.heroAddress,
        name: contestant.name, heroClass: contestant.heroClass,
      }].sort((a, b) => a.slot - b.slot);
      next.circus = {
        ...state.circus,
        contestants: state.circus.contestants.map((row) => ({
          ...row,
          inLineup: slots.some((slot) => slot.heroAddress === row.heroAddress),
        })),
        slots,
      };
      break;
    }
    case "circus_combat_snapshot_started":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.circusCombat = {
        active: true, pickOpen: event.pickOpen, battleState: event.battleState,
        partyCount: event.partyCount, complete: false, heroes: [],
      };
      break;
    case "circus_combat_hero_observed": {
      const arena = state.circusCombat ?? {
        active: true, pickOpen: false, battleState: 0, partyCount: 0, complete: false, heroes: [],
      };
      next.circusCombat = {
        ...arena,
        heroes: [...arena.heroes.filter((hero) => hero.index !== event.index), {
          index: event.index, actorGuid: event.actorGuid, actorAddress: event.actorAddress,
          canActivate: event.canActivate, active: event.active, name: event.name,
        }].sort((left, right) => left.index - right.index),
      };
      break;
    }
    case "circus_combat_snapshot_completed":
      if (state.circusCombat !== undefined) next.circusCombat = { ...state.circusCombat, complete: true };
      break;
    case "circus_hero_activation_observed":
      if (state.circusCombat !== undefined && event.observed) {
        next.circusCombat = {
          ...state.circusCombat, pickOpen: false,
          heroes: state.circusCombat.heroes.map((hero) => ({
            ...hero, active: hero.actorGuid === event.actorGuid, canActivate: false,
          })),
        };
      }
      break;
    default: return false;
  }
  return true;
}
