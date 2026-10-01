import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceCamp(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "camp_observed":
      next.camp = {
        phase: event.phase,
        points: event.points,
        mealOptionCount: event.mealOptionCount,
        meals: [],
      };
      if (event.phase > 0) {
        next.phase = "camp";
      } else if (state.phase === "camp") {
        const currentAreaId = state.dungeonMap?.currentAreaId;
        const currentArea = state.dungeonMap?.areas.find(
          (area) => area.areaId === currentAreaId,
        );
        next.phase = currentArea?.areaKind === 0 ? "room" : "unknown";
      }
      break;
    case "camp_meal_observed":
      if (state.camp !== undefined) {
        next.camp = {
          ...state.camp,
          meals: [
            ...state.camp.meals.filter((meal) => meal.optionIndex !== event.optionIndex),
            {
              optionIndex: event.optionIndex,
              foodRequired: event.foodRequired,
              foodAvailable: event.foodAvailable,
              text: event.text,
            },
          ].sort((left, right) => left.optionIndex - right.optionIndex),
        };
      }
      break;
    default: return false;
  }
  return true;
}
