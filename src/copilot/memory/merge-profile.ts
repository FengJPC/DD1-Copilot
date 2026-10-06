/** Town observations cannot carry a previous expedition's HP as current HP. */
export function mergeHeroProfile(prior: Record<string, unknown>, update: Record<string, unknown>, name: string) {
  const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
  const profile: Record<string, unknown> = { ...prior, ...defined, name,
    ...(defined.training ? { training: { ...(prior.training as object ?? {}), ...defined.training as object } } : {}) };
  if (defined.townHealth) {
    profile.healthSource = 'town_unverified';
    if (typeof prior.currentHp === 'number') profile.lastRaidHealth = {
      currentHp: prior.currentHp, maxHp: prior.maxHp, source: 'prior_expedition_observation',
    };
    delete profile.currentHp;
    delete profile.maxHp;
    delete profile.healthText; // Retired, ambiguous town ratio stays in historical/raw records.
  } else if (typeof defined.currentHp === 'number') {
    delete profile.townHealth;
    profile.healthSource = 'raid_actor';
  }
  return profile;
}
