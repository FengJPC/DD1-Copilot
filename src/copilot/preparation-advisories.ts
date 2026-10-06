import type { GameState } from '../state/game-state.js';
import { townHealth } from './town-health.js';

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
  const advisories: Array<Record<string, unknown>> = [{
    kind: 'prepare_trinkets',
    message: '出征前检查并配置四名英雄的饰品，结合任务、位置和技能选择；unknown 表示尚未核实，不能视为空槽或已配置。',
    equipmentControl: state.equipment?.complete && state.equipment.nativeControl
      ? 'native_id_actions' : 'refresh_updated_bridge_before_equipment_actions',
    party,
  }];
  const uncertainHealth = (state.partyPlanning?.rosterCandidates ?? [])
    .filter(hero => !!hero.healthText)
    .map(hero => ({ heroGuid: hero.heroGuid, name: hero.name, health: townHealth(hero.healthText) }));
  if (uncertainHealth.length) advisories.push({
    kind: 'verify_town_health',
    message: '城镇只报告已读取的最大生命；当前生命字段可能是未初始化值，不能用于判断濒死或满血。出征后由实时队伍状态提供当前生命。',
    heroes: uncertainHealth,
  });
  return advisories;
}
