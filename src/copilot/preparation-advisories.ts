import type { GameState } from '../state/game-state.js';

// A reminder is an observation of the current lineup, not a claim that the
// party is equipped. Unknown slots remain unknown until a fresh native read.
export function preparationAdvisories(state: GameState): Array<Record<string, unknown>> {
  if (state.phase !== 'embark' && state.phase !== 'provision') return [];
  const party = (state.partyPlanning?.slots ?? [])
    .filter((slot) => slot.heroGuid !== undefined || slot.name.length > 0)
    .sort((a, b) => a.position - b.position)
    .map((slot) => {
      const profile = slot.heroGuid === undefined ? undefined
        : state.partyPlanning?.rosterCandidates.find((hero) => hero.heroGuid === slot.heroGuid);
      const trinkets = [0, 1].map((index) => profile?.trinkets?.find((item) => item.slot === index)
        ?? { slot: index, status: 'unknown' as const });
      return { position: slot.position, heroGuid: slot.heroGuid, name: slot.name, trinkets };
    });
  return [{
    kind: 'prepare_trinkets',
    message: '出征前检查并配置四名英雄的饰品，结合任务、位置和技能选择；unknown 表示尚未核实，不能视为空槽或已配置。',
    equipmentControl: 'manual_until_verified_equipment_action_available',
    party,
  }];
}
