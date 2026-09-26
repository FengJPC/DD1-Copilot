/**
 * A live helper request may omit expectedRevision for routine, non-combat
 * actions. In that case the helper snapshots the game immediately before the
 * action and supplies that revision. Explicit values still pass through the
 * engine's strict schema, including malformed values that become NaN.
 */
export function resolveLiveExpectedRevision(
  value: unknown,
  currentRevision: number,
): number {
  return value === undefined || value === null
    ? currentRevision
    : Number(value);
}

export interface LiveActionStateSource<T> {
  getState(mode: "compact", sinceRevision: number): Promise<T>;
  forceRefresh(
    mode: "compact",
    sinceRevision: number,
    includeMap: boolean,
  ): Promise<T>;
}

/**
 * An append-only DD1 log can reconstruct a coherent but obsolete overlay from
 * a previous game process. The first action in every helper process therefore
 * requires a game-side inspection before it may use the reconstructed state.
 */
export async function observeLiveActionState<T>(
  source: LiveActionStateSource<T>,
  alreadyPrimed: boolean,
): Promise<T> {
  return alreadyPrimed
    ? source.getState("compact", 0)
    : source.forceRefresh("compact", 0, false);
}
