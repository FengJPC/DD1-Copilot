import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reducePreparation(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case 'equipment_unavailable':
      next.equipment = undefined;
      break;
    case 'equipment_snapshot_started':
      next.equipment = { complete: false, nativeControl: event.nativeControl, items: [] };
      break;
    case 'equipment_item_observed':
      if (state.equipment && !state.equipment.complete) next.equipment = { ...state.equipment,
        items: [...state.equipment.items.filter(item => item.inventorySlot !== event.inventorySlot),
          { inventorySlot: event.inventorySlot, amount: event.amount, itemId: event.itemId,
            name: event.name, effects: event.effects, classRequirement: event.classRequirement }] };
      break;
    case 'equipment_snapshot_completed':
      if (state.equipment) next.equipment = { ...state.equipment,
        complete: event.itemCount === state.equipment.items.length };
      break;
    case "embark_ready":
      next.expedition = {
        questCount: event.questCount,
        locationCount: event.locationCount,
        cursorColumn: event.cursorColumn,
        cursorRow: event.cursorRow,
        locations: [],
        quests: [],
      };
      next.phase = "embark";
      break;
    case "embark_state_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          questScreenState: event.questScreenState,
          selectedQuestIndex: event.selectedQuestIndex,
          specialQuestIndex: event.specialQuestIndex,
        };
      }
      break;
    case "embark_location_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          locations: [
            ...state.expedition.locations.filter(
              (location) => location.column !== event.column,
            ),
            {
              column: event.column,
              dungeonId: event.dungeonId,
              questCount: event.questCount,
            },
          ].sort((left, right) => left.column - right.column),
        };
      }
      break;
    case "embark_quest_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          quests: [
            ...state.expedition.quests.filter(
              (quest) => quest.questIndex !== event.questIndex,
            ),
            {
              row: event.row,
              questIndex: event.questIndex,
              questId: event.questId,
              dungeonId: event.dungeonId,
              length: event.length,
              difficulty: event.difficulty,
              elementId: event.elementId,
              onScreen: event.onScreen,
              details: [],
            },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "embark_quest_detail_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          quests: state.expedition.quests.map((quest) => {
            if (quest.questIndex !== event.questIndex) return quest;
            const details = [...quest.details];
            details[event.line] = event.text;
            return { ...quest, details };
          }),
        };
      }
      break;
    case "embark_cursor_location_changed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          cursorColumn: event.column,
          cursorRow: 0,
        };
      }
      break;
    case "embark_quest_selected":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          selectedQuestIndex: event.questIndex,
        };
      }
      break;
    case "embark_forward_outcome":
      if (event.provision) next.phase = "provision";
      break;
    case "preparation_snapshot_started":
      if (event.section === "party") next.partyPlanning = { slotCount: 4, filledCount: 0, slots: [], rosterCandidates: [] };
      else next.provisioning = { items: [] };
      break;
    case "provision_wallet_observed":
      next.provisioning = { ...(state.provisioning ?? { items: [] }), gold: event.gold, shards: event.shards, bagTotal: event.bagTotal };
      break;
    case "party_slot_observed": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        slots: [
          ...planning.slots.filter((slot) => slot.slot !== event.slot),
          {
            slot: event.slot,
            position: event.position,
            heroAddress: event.heroAddress,
            heroGuid: event.heroGuid,
            entryAddress: event.entryAddress,
            name: event.name,
            barred: event.barred,
            elementId: event.elementId,
          },
        ].sort((left, right) => left.slot - right.slot),
      };
      break;
    }
    case "party_lineup_ready": {
      const planning = state.partyPlanning ?? {
        slotCount: event.slotCount,
        filledCount: event.filledCount,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        slotCount: event.slotCount,
        filledCount: event.filledCount,
        picker: undefined,
      };
      break;
    }
    case "party_lineup_closed":
      if (state.expedition !== undefined) next.phase = "embark";
      break;
    case 'roster_trinket_observed': {
      const planning = state.partyPlanning;
      if (planning) next.partyPlanning = {
        ...planning,
        rosterCandidates: planning.rosterCandidates.map((hero) => hero.heroGuid === event.heroGuid
          ? { ...hero, trinkets: [
              ...(hero.trinkets ?? []).filter((item) => item.slot !== event.slot),
              { slot: event.slot, status: event.status, itemId: event.itemId || undefined,
                name: event.name || undefined, effects: event.effects || undefined },
            ].sort((a, b) => a.slot - b.slot) }
          : hero),
      };
      break;
    }
    case "roster_profile_observed": {
      const planning = state.partyPlanning;
      if (planning) next.partyPlanning = {
        ...planning,
        rosterCandidates: planning.rosterCandidates.map((hero) => hero.heroGuid === event.heroGuid
          ? {
            ...hero, name: event.name || hero.name, heroClass: event.heroClass, level: event.level,
            healthText: event.healthText, stressText: event.stressText,
            weaponLevel: event.weaponLevel, armourLevel: event.armourLevel,
            quirks: hero.quirks ?? [], diseases: hero.diseases ?? []
          }
          : hero),
      };
      break;
    }
    case "roster_profile_detail_observed": {
      const planning = state.partyPlanning;
      if (planning) next.partyPlanning = {
        ...planning,
        rosterCandidates: planning.rosterCandidates.map((hero) => {
          if (hero.heroGuid !== event.heroGuid) return hero;
          const key = event.category === "quirk" ? "quirks" : "diseases";
          const rows = [...(hero[key] ?? [])];
          rows[event.line] = event.text;
          return { ...hero, [key]: rows };
        }),
      };
      break;
    }
    case "party_hero_added": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      const existing = planning.slots.find((slot) => slot.slot === event.slot);
      next.partyPlanning = {
        ...planning,
        filledCount:
          event.state === 1 && !existing?.name
            ? Math.min(planning.slotCount, planning.filledCount + 1)
            : planning.filledCount,
        slots: [
          ...planning.slots.filter((slot) => slot.slot !== event.slot),
          {
            slot: event.slot,
            position: event.position,
            heroAddress: "",
            entryAddress: "",
            name: event.state === 1 ? event.name : "",
            barred: false,
            elementId: existing?.elementId ?? "",
          },
        ].sort((left, right) => left.slot - right.slot),
        picker: undefined,
        rosterCandidates: planning.rosterCandidates.map((hero) =>
          hero.name === event.name ? { ...hero, state: event.state } : hero,
        ),
      };
      break;
    }
    case "provision_ready":
      next.provisioning = { items: [] };
      next.phase = "provision";
      break;
    case "provision_section_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      next.provisioning = {
        ...provisioning,
        probeSection: event.section,
      };
      break;
    }
    case "provision_item_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      const section = provisioning.probeSection;
      if (section !== undefined) {
        const itemKey =
          event.itemId || (event.itemType === "provision" ? "food" : event.itemType);
        next.provisioning = {
          ...provisioning,
          items: [
            ...provisioning.items.filter(
              (item) => item.section !== section || item.slot !== event.slot,
            ),
            {
              section,
              slot: event.slot,
              amount: event.amount,
              itemType: event.itemType,
              itemId: event.itemId,
              itemKey,
              priceKnown: event.priceKnown,
              goldPrice: event.goldPrice,
              shardPrice: event.shardPrice,
              freeCount: event.freeCount,
            },
          ].sort(
            (left, right) =>
              left.section - right.section || left.slot - right.slot,
          ),
        };
      }
      break;
    }
    case "provision_transaction_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      next.provisioning = {
        ...provisioning,
        gold: event.gold,
        shards: event.shards,
        bagTotal: event.bagTotal,
      };
      break;
    }
    default: return false;
  }
  return true;
}
