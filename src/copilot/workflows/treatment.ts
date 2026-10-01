import type { CombatLogSnapshot } from '../../live/combat-log-source.js';
import type { WorkflowResult } from '../execution-types.js';
import type { ActionStepRecord, CopilotAction } from '../types.js';
import type { WorkflowContext } from '../workflow-context.js';
import { runTownIdentityCommand } from './town.js';

type TreatmentAction = Extract<CopilotAction, { kind: 'prepare_town_treatment' | 'choose_town_treatment' | 'confirm_town_treatment' }>;

export async function townTreatment(context: WorkflowContext, action: TreatmentAction,
  before: CombatLogSnapshot, steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const { kind, ...args } = action;
  return runTownIdentityCommand(context, kind, before, { kind, args }, (snapshot) => {
    const row = snapshot.state.buildingDetails?.activities.find((row) => row.activityId === action.activityId && row.slot === action.slot);
    if (action.kind === 'prepare_town_treatment') return row?.pendingHeroGuid === action.heroGuid
      ? { outcome: 'success', reason: 'The intended hero is pending; no treatment has been paid for.' } : undefined;
    if (action.kind === 'choose_town_treatment') return snapshot.state.buildingDetails?.treatments?.some((choice) =>
      choice.activityId === action.activityId && choice.slot === action.slot && choice.quirkId === action.quirkId && choice.mode === action.mode && choice.chosen)
      ? { outcome: 'success', reason: 'The game reports the intended treatment selected.' } : undefined;
    return row?.committedHeroGuid === action.heroGuid ? { outcome: 'success', reason: 'The intended hero is committed to treatment.' } : undefined;
  }, steps, action.kind === 'prepare_town_treatment'
    ? `Prepared hero ${action.heroGuid} for treatment; choose a quirk and confirm separately.`
    : action.kind === 'choose_town_treatment' ? `Selected ${action.quirkId} for ${action.mode === 1 ? 'locking' : 'removal'}; awaiting explicit treatment confirmation.`
      : `Committed hero ${action.heroGuid} to the selected treatment.`);
}
