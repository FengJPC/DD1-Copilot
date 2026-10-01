import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceTownDetails(state: GameState, next: GameState, event: BlindestEvent): boolean {
  const details = state.buildingDetails;
  switch (event.kind) {
    case 'roster_capacity_observed':
      next.recruitment = { ...state.recruitment, rosterCount: event.rosterCount, rosterCapacity: event.rosterCapacity };
      return true;
    case 'recruit_profile_observed':
      next.buildingHeroes = state.buildingHeroes.map((hero) => hero.heroAddress === event.heroAddress
        ? { ...hero, heroClass: event.heroClass, level: event.level, healthText: event.healthText, stressText: event.stressText,
            quirks: [], diseases: [] } : hero);
      return true;
    case 'recruit_detail_observed':
      next.buildingHeroes = state.buildingHeroes.map((hero) => {
        if (hero.heroAddress !== event.heroAddress) return hero;
        const key = event.category === 'quirk' ? 'quirks' : 'diseases';
        const lines = [...(hero[key] ?? [])]; lines[event.line] = event.text;
        return { ...hero, [key]: lines };
      });
      return true;
    case 'building_capabilities_observed':
      if (details) next.buildingDetails = { ...details, canUpgrade: event.canUpgrade };
      return true;
    case 'building_shop_currency_observed':
      if (details) next.buildingDetails = { ...details, shopItems: details.shopItems.map((item) => ({ ...item, currency: event.currency })) };
      return true;
    case 'building_activity_candidate_observed':
      if (details) {
        const { kind: _kind, raw: _raw, tick: _tick, ...candidate } = event;
        next.buildingDetails = { ...details, activityCandidates: [
          ...(details.activityCandidates ?? []).filter((hero) => !(hero.activityId === event.activityId && hero.slot === event.slot && hero.heroGuid === event.heroGuid)), candidate,
        ] };
      }
      return true;
    case 'building_activity_kind_observed':
      if (details) next.buildingDetails = { ...details, activities: details.activities.map((row) =>
        row.activityId === event.activityId && row.slot === event.slot ? { ...row, treatment: event.treatment } : row) };
      return true;
    case 'town_treatment_observed':
      if (details) {
        const { kind: _kind, raw: _raw, tick: _tick, ...choice } = event;
        next.buildingDetails = { ...details, treatments: [...(details.treatments ?? []).filter((row) =>
          !(row.activityId === event.activityId && row.slot === event.slot && row.quirkId === event.quirkId && row.mode === event.mode)), choice] };
      }
      return true;
    case 'building_hero_step_metadata_observed':
      if (details) next.buildingDetails = { ...details, heroOptions: details.heroOptions.map((option) =>
        option.optionId === event.optionId ? { ...option, stepDetails: option.stepDetails.map((step) =>
          step.code === event.code ? { ...step, available: event.available, costKnown: event.costKnown, lockReason: event.lockReason,
            costs: step.costs ?? [] } : step) } : option) };
      return true;
    case 'building_cost_observed': {
      if (!details) return true;
      const add = (costs: Array<{ currency: string; amount: number }> = []) => [
        ...costs.filter((cost) => cost.currency !== event.currency), { currency: event.currency, amount: event.amount },
      ];
      next.buildingDetails = event.owner === 'hero'
        ? { ...details, heroOptions: details.heroOptions.map((option) => option.optionId === event.id
          ? { ...option, stepDetails: option.stepDetails.map((step) => step.code === event.code ? { ...step, costs: add(step.costs) } : step) } : option) }
        : { ...details, upgrades: details.upgrades.map((track) => track.trackId === event.id && String.fromCharCode(97 + track.next) === event.code
          ? { ...track, costs: add(track.costs) } : track) };
      return true;
    }
    case 'building_hero_effect_observed':
      if (details) next.buildingDetails = { ...details, heroOptions: details.heroOptions.map((option) => {
        if (option.optionId !== event.optionId) return option;
        const effects = (option.effects ?? []).map((column) => [...column]);
        const column = effects[event.column] ?? []; column[event.line] = event.text; effects[event.column] = column;
        return { ...option, effects };
      }) };
      return true;
    case 'building_facility_metadata_observed':
      if (details) next.buildingDetails = { ...details, upgrades: details.upgrades.map((track) =>
        track.track === event.track ? { ...track, available: event.available, costKnown: event.costKnown,
          description: event.description, costs: track.costs ?? [] } : track) };
      return true;
    default: return false;
  }
}
