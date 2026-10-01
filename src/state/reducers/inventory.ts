import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceInventory(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "event_opened":
      next.phase = "event";
      next.eventOverlay = {
        active: true,
        openedTick: event.tick,
        skin: event.skin,
        rowCount: event.rowCount,
        pickingItem: false,
        title: event.title,
        flavour: "",
        options: [],
        compatibleInventorySlots: [],
      };
      break;
    case "event_closed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = { ...state.eventOverlay, active: false };
      }
      break;
    case "event_option_activated": {
      if (/^(?:无视|忽略|ignore|leave)$/iu.test(event.name.trim())) {
        const sourceProp = state.room?.props?.find(
          (prop) => prop.active && prop.reachable,
        );
        if (sourceProp !== undefined) {
          next.ignoredPropKeys = [
            ...new Set([
              ...state.ignoredPropKeys,
              `${sourceProp.address}\u0000${sourceProp.name}`,
            ]),
          ];
        }
      }
      break;
    }
    case "inventory_snapshot_started":
      next.inventoryInfo = {
        slotCount: event.slotCount,
        occupiedCount: event.occupiedCount,
      };
      break;
    case "inventory_item_observed":
      next.inventory = [
        ...state.inventory.filter((item) => item.slot !== event.slot),
        {
          slot: event.slot,
          amount: event.amount,
          itemType: event.itemType,
          itemId: event.itemId,
          itemKey: event.itemKey,
          name: event.name,
        },
      ].sort((left, right) => left.slot - right.slot);
      break;
    case "inventory_snapshot_completed":
      if (state.inventoryInfo !== undefined) {
        next.inventoryInfo = { ...state.inventoryInfo, completedTick: event.tick };
      }
      break;
    case "event_snapshot_started":
      next.phase = "event";
      next.eventOverlay = {
        active: true,
        openedTick: state.eventOverlay?.openedTick ?? event.tick,
        skin: event.skin,
        rowCount: event.rowCount,
        pickingItem: event.pickingItem,
        title: event.title,
        flavour: event.flavour,
        options: [],
        compatibleInventorySlots: [],
      };
      break;
    case "event_option_observed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = {
          ...state.eventOverlay,
          options: [
            ...state.eventOverlay.options.filter(
              (option) => option.optionIndex !== event.optionIndex,
            ),
            {
              optionIndex: event.optionIndex,
              name: event.name,
              description: event.description,
              itemSlot: event.itemSlot,
              enabled: event.enabled,
            },
          ].sort((left, right) => left.optionIndex - right.optionIndex),
        };
      }
      break;
    case "event_item_compatibility_observed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = {
          ...state.eventOverlay,
          compatibleInventorySlots: event.works
            ? [...new Set([...state.eventOverlay.compatibleInventorySlots, event.slot])].sort(
              (left, right) => left - right,
            )
            : state.eventOverlay.compatibleInventorySlots.filter(
              (slot) => slot !== event.slot,
            ),
        };
      }
      break;
    case "event_snapshot_completed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = { ...state.eventOverlay, completedTick: event.tick };
      }
      break;
    case "loot_snapshot_started":
      next.loot = {
        active: true,
        openedTick: state.loot?.openedTick ?? event.tick,
        itemCount: event.itemCount,
        token: state.loot?.token ?? "",
        items: [],
      };
      break;
    case "loot_item_observed":
      if (state.loot !== undefined) {
        next.loot = {
          ...state.loot,
          items: [
            ...state.loot.items.filter(
              (item) => item.itemIndex !== event.itemIndex,
            ),
            {
              itemIndex: event.itemIndex,
              poolSlot: event.poolSlot,
              amount: event.amount,
              itemType: event.itemType,
              itemId: event.itemId,
              itemKey: event.itemKey,
              name: event.name,
            },
          ].sort((left, right) => left.itemIndex - right.itemIndex),
        };
      }
      break;
    case "loot_snapshot_completed":
      if (state.loot !== undefined) {
        next.loot = { ...state.loot, completedTick: event.tick };
      }
      break;
    case "light_observed":
      next.light = {
        kind: event.lightKind,
        value: event.value,
        level: event.level,
        text: event.text,
      };
      break;
    case "loot_opened":
      if (event.token === "battle") {
        next.combatEndCandidate = true;
      }
      next.phase = "loot";
      next.loot = {
        active: true,
        openedTick: event.tick,
        itemCount: event.itemCount,
        token: event.token,
        items: [],
      };
      break;
    case "loot_closed":
      if (state.loot !== undefined) {
        next.loot = { ...state.loot, active: false, itemCount: 0 };
      }
      if (next.combatEndCandidate) next.phase = "post_combat";
      break;
    default: return false;
  }
  return true;
}
