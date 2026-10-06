import type { GameState } from '../state/game-state.js';
import type { CopilotAction } from './types.js';

export type EquipmentAction = Extract<CopilotAction, { kind: 'equip_trinket' | 'unequip_trinket' }>;

export function equipmentItem(state: GameState, action: Extract<EquipmentAction, { kind: 'equip_trinket' }>) {
  const matches = state.equipment?.items.filter(item => item.itemId === action.itemId && item.amount === 1 &&
    (action.inventorySlot === undefined || item.inventorySlot === action.inventorySlot)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function equipmentFailure(state: GameState, action: EquipmentAction): string | undefined {
  if (!['town', 'embark', 'provision'].includes(state.phase)) return 'Manage campaign trinkets from town or expedition preparation.';
  if (!state.equipment?.complete || !state.equipment.nativeControl) return 'Refresh a complete equipment snapshot from the updated native bridge.';
  const heroes = state.partyPlanning?.rosterCandidates.filter(hero => hero.heroGuid === action.heroGuid) ?? [];
  if (heroes.length !== 1 || heroes[0]!.missing || ![0, 1].includes(heroes[0]!.state)) return 'The roster hero is missing, ambiguous, or unavailable.';
  const slots = heroes[0]!.trinkets?.filter(item => item.slot === action.slot) ?? [];
  if (slots.length !== 1 || slots[0]!.status === 'unknown') return 'The target trinket slot is not verified.';
  if (action.kind === 'unequip_trinket') return slots[0]!.status === 'equipped' && slots[0]!.itemId === action.itemId
    ? undefined : 'The equipped item ID does not match the requested trinket.';
  if (slots[0]!.status !== 'empty') return 'Unequip the current trinket first; implicit replacement is not supported.';
  if (!equipmentItem(state, action)) return 'Trinket ID is missing, stacked, or ambiguous; use its current inventorySlot.';
  if (heroes[0]!.trinkets?.some(item => item.status === 'equipped' && item.itemId === action.itemId)) return 'This hero already wears that trinket.';
  // Native bridge checks the authoritative class requirement, including mods/localization.
  return undefined;
}

export function equipmentOptions(state: GameState) {
  if (!state.equipment?.complete || !state.equipment.nativeControl) return [];
  return [
    { kind: 'equip_trinket' as const, heroGuid: 'roster GUID', itemId: 'owned trinket ID', slot: '0 or 1', inventorySlot: 'required if ID is ambiguous' },
    { kind: 'unequip_trinket' as const, heroGuid: 'roster GUID', itemId: 'equipped trinket ID', slot: '0 or 1' },
  ];
}
