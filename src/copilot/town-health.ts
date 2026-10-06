/** Town actor HP can be a constructor/save placeholder. Only raid HP is live HP. */
export function townHealth(healthText?: string) {
  const match = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/u.exec(healthText ?? '');
  const maxHp = match ? Number(match[2]) : undefined;
  return {
    source: 'town_actor' as const,
    currentHpVerified: false as const,
    ...(maxHp !== undefined && Number.isFinite(maxHp) && maxHp > 0 ? { maxHp } : {}),
  };
}

/** Raw text remains in full diagnostics, never presented as confirmed current HP. */
export function townHeroView<T extends { healthText?: string }>(hero: T) {
  const { healthText, ...rest } = hero;
  return { ...rest, health: townHealth(healthText) };
}
