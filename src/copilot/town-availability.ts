import type { GameState } from '../state/game-state.js';

type Details = NonNullable<GameState['buildingDetails']>;

export function canOpenBuildingUpgrades(state: GameState): boolean {
  return state.phase === 'building' && state.buildingDetails?.mode === 0 &&
    state.buildingDetails.canUpgrade === true;
}

export function townPriceFailure(state: GameState, priceKnown: boolean, price: number, currency?: string): string | undefined {
  if (!priceKnown || price < 0 || !currency) return 'The current price or currency is unknown; refresh before purchasing.';
  const wallet = state.townWallet;
  if (!wallet || !(currency in wallet)) return `The current ${currency} balance is unknown.`;
  return wallet[currency as keyof typeof wallet] < price ? `Insufficient ${currency}: need ${price}, have ${wallet[currency as keyof typeof wallet]}.` : undefined;
}

export function heroUpgradeFailure(state: GameState, option: Details['heroOptions'][number], step: Details['heroOptions'][number]['stepDetails'][number]): string | undefined {
  if (step.purchased || option.stepDetails.indexOf(step) !== option.next) return 'This is not the next unpurchased step.';
  if (step.available !== true) return step.lockReason || 'Upgrade availability has not been verified by the game.';
  if (step.costKnown !== true) return 'The live upgrade price is unknown.';
  for (const cost of step.costs ?? [{ currency: step.currency, amount: step.cost }]) {
    const failure = townPriceFailure(state, true, cost.amount, cost.currency);
    if (failure) return failure;
  }
  return undefined;
}

export function activityCandidate(state: GameState, activityId: string, slot: number, heroGuid: number) {
  return state.buildingDetails?.activityCandidates?.find((hero) =>
    hero.activityId === activityId && hero.slot === slot && hero.heroGuid === heroGuid);
}

export function facilityUpgradeFailure(state: GameState, track: Details['upgrades'][number]): string | undefined {
  if (track.next < 0 || track.available !== true) return 'This facility upgrade is locked or unverified.';
  if (track.costKnown !== true) return 'The live facility upgrade price is unknown.';
  for (const cost of track.costs ?? []) {
    const failure = townPriceFailure(state, true, cost.amount, cost.currency);
    if (failure) return failure;
  }
  return undefined;
}

export function treatmentConfirmationFailure(state: GameState, activityId: string, slot: number, heroGuid: number): string | undefined {
  const row = state.buildingDetails?.activities.find((row) => row.activityId === activityId && row.slot === slot);
  if (state.phase !== 'building' || !row?.treatment || row.pendingHeroGuid !== heroGuid || row.committedHeroGuid !== undefined)
    return 'This hero is not pending in the specified treatment slot.';
  const chosen = state.buildingDetails?.treatments?.filter((choice) => choice.activityId === activityId && choice.slot === slot && choice.chosen) ?? [];
  if (chosen.length === 0) return 'Choose a treatment before confirming.';
  const totals = new Map<string, number>();
  for (const choice of chosen) {
    if (!choice.priceKnown || choice.price < 0 || !choice.currency) return 'A chosen treatment price is unknown.';
    totals.set(choice.currency, (totals.get(choice.currency) ?? 0) + choice.price);
  }
  for (const [currency, price] of totals) {
    const failure = townPriceFailure(state, true, price, currency);
    if (failure) return failure;
  }
  return undefined;
}
