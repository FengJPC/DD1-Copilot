/** Compatibility entry point for existing callers. State includes every game scene. */
export { initialGameState as initialCombatState, reduceGameState as reduceCombatState } from './game-state.js';
export type { GameState as CombatState, GamePhase } from './game-state.js';
