import type { CombatLogSnapshot } from '../../live/combat-log-source.js';
import { equipmentItem, type EquipmentAction } from '../equipment.js';
import type { ActionStepRecord } from '../types.js';
import type { WorkflowContext } from '../workflow-context.js';
import { resultFromStep } from '../step-executor.js';

/** One native call, one receipt: both inventories must reconcile in that command. */
export async function changeTrinket(context: WorkflowContext, action: EquipmentAction,
  before: CombatLogSnapshot, steps: ActionStepRecord[]) {
  const beforeCount = before.state.equipment!.items.filter(item => item.itemId === action.itemId)
    .reduce((sum, item) => sum + item.amount, 0);
  const item = action.kind === 'equip_trinket' ? equipmentItem(before.state, action)! : undefined;
  const step = await context.executeStep(action.kind, before, {
    kind: action.kind, args: { heroGuid: action.heroGuid, slot: action.slot, itemId: action.itemId,
      ...(item ? { inventorySlot: item.inventorySlot } : {}) },
  }, (snapshot, observations, commandId) => {
    // Never accept a queued acknowledgement or an unrelated old snapshot.
    const start = observations.findIndex(record => record.message === `agent-command: begin id=${commandId}`);
    if (start < 0) return undefined;
    const end = observations.findIndex((record, index) => index > start && record.message === `agent-command: end id=${commandId} accepted=1`);
    if (end < 0) return undefined;
    const scoped = observations.slice(start, end);
    if (scoped.some(record => /^agent-equipment: outcome_unknown /u.test(record.message ?? '')))
      return { outcome: 'uncertain' as const, reason: 'Native equipment operation may have executed; refresh and reconcile before another action.' };
    if (!scoped.some(record => record.event?.kind === 'equipment_snapshot_completed') || !snapshot.state.equipment?.complete) return undefined;
    if (!scoped.some(record => record.event?.kind === 'roster_trinket_observed' &&
      record.event.heroGuid === action.heroGuid && record.event.slot === action.slot)) return undefined;
    const slot = snapshot.state.partyPlanning?.rosterCandidates.find(hero => hero.heroGuid === action.heroGuid)
      ?.trinkets?.find(trinket => trinket.slot === action.slot);
    const count = snapshot.state.equipment.items.filter(trinket => trinket.itemId === action.itemId)
      .reduce((sum, trinket) => sum + trinket.amount, 0);
    const equipped = action.kind === 'equip_trinket';
    const expectedDelta = equipped ? -1 : 1;
    const matches = equipped ? slot?.status === 'equipped' && slot.itemId === action.itemId : slot?.status === 'empty';
    return matches && count === beforeCount + expectedDelta
      ? { outcome: 'success' as const, reason: `Hero ${action.heroGuid} slot ${action.slot} and realm inventory both verified.` }
      : { outcome: 'uncertain' as const, reason: 'Native call completed but the hero slot and realm inventory did not reconcile. Refresh before another action.' };
  });
  steps.push(step.record);
  return resultFromStep(step, `${action.kind} verified for hero ${action.heroGuid}.`);
}
