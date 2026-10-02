import type { GameState } from '../../state/game-state.js';

export interface HeroProfileObservation {
  heroGuid: number;
  name: string;
  profile: Record<string, unknown>;
}

/** Only persist stable roster GUIDs; process-local recruit/actor addresses are not identities. */
export function collectHeroProfiles(state: GameState): HeroProfileObservation[] {
  if (state.circusCombat?.active) return [];
  const profiles: HeroProfileObservation[] = [];
  const phase = state.phase === 'modal' ? state.modalSourcePhase : state.phase;
  if (phase === 'embark' || phase === 'provision') {
    for (const hero of state.partyPlanning?.rosterCandidates ?? []) {
      if (!hero.heroGuid || !hero.heroClass) continue;
      profiles.push({ heroGuid: hero.heroGuid, name: hero.name, profile: {
        heroClass: hero.heroClass, level: hero.level, healthText: hero.healthText, stressText: hero.stressText,
        weaponLevel: hero.weaponLevel, armourLevel: hero.armourLevel,
        quirks: hero.quirks, diseases: hero.diseases, trinkets: hero.trinkets,
      } });
    }
  }
  if (phase === 'building' && state.focusedHero && state.buildingDetails?.selectedHeroGuid) {
    const hero = state.focusedHero;
    profiles.push({ heroGuid: state.buildingDetails.selectedHeroGuid, name: hero.name, profile: {
      heroClass: hero.heroClass, level: hero.level, xp: hero.xp,
      ...(state.buildingDetails.heroOptions.length ? { training: {
        [state.buildingDetails.buildingId]: state.buildingDetails.heroOptions,
      } } : {}),
    } });
  }
  if (['room', 'traveling', 'combat', 'targeting', 'post_combat', 'event', 'loot', 'camp'].includes(phase ?? '')) {
    for (const hero of state.combatants) {
      if (hero.side !== 'party' || !hero.heroGuid) continue;
      profiles.push({ heroGuid: hero.heroGuid, name: hero.name, profile: {
        currentHp: hero.currentHp, maxHp: hero.maxHp, stress: hero.stress, conditions: hero.conditions,
        ...(state.currentActor?.address === hero.actorAddress ? {
          heroClass: state.currentActor.heroClass,
          activeSkills: state.combatActions.filter(action=>action.kind==='skill').map(({skillSlot,elementId,name,details})=>({skillSlot,elementId,name,details})),
        } : {}),
        ...(hero.details.length ? { details: hero.details } : {}),
        ...(hero.resists.length ? { resists: hero.resists } : {}),
        // Empty arrays only establish absence when full hero details are present.
        ...(hero.details.length ? { quirks: hero.quirks, diseases: hero.diseases } : {}),
      } });
    }
  }
  return profiles;
}
