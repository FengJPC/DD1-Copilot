interface TacticalActorSource {
  actorGuid?: number;
  address?: string;
  name?: string;
  heroClass?: string;
  currentHp?: number;
  maxHp?: number;
  stress?: number;
  maxStress?: number;
}

interface TacticalCombatantSource {
  side: "party" | "enemy";
  sideIndex?: number;
  slot: number;
  slotEnd: number;
  actorAddress?: string;
  actorGuid?: number;
  heroGuid?: number;
  active?: boolean;
  name: string;
  currentHp?: number;
  maxHp?: number;
  stress?: number;
  maxStress?: number;
  conditions?: string;
  details?: string[];
  resists?: string[];
  quirks?: string[];
  diseases?: string[];
}

interface TacticalSkillSource {
  elementId?: string;
  skillSlot?: number;
  name: string;
  details?: string[];
}

interface TacticalEventSource {
  tick?: number;
  kind?: string;
  actorAddress?: string;
  resultType?: string;
  text?: string;
  [key: string]: unknown;
}

interface TacticalTargetSource {
  side?: "party" | "enemy";
  slot?: number;
  slotEnd?: number;
  name?: string;
  currentHp?: number;
  maxHp?: number;
  conditions?: string;
}

export interface TacticalStateSource {
  revision: number;
  observedAt?: string;
  phase?: string;
  context?: string;
  light?: unknown;
  quest?: unknown;
  decision?: {
    kind?: string;
    selectedSkill?: unknown;
    currentTarget?: TacticalTargetSource;
  };
  combat?: {
    active?: boolean;
    actor?: TacticalActorSource;
    party: TacticalCombatantSource[];
    enemies: TacticalCombatantSource[];
    skills: TacticalSkillSource[];
    selectedSkill?: unknown;
    currentTarget?: TacticalTargetSource;
    recentResults?: TacticalEventSource[];
    recentBuffs?: TacticalEventSource[];
  };
}

function nonEmpty(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function staticProfileDetail(detail: string): string | undefined {
  const dynamicPrefix = /^\d+\/\d+\s+(?:生命|压力|Health|Stress)[：:]?(.*)$/iu.exec(
    detail,
  );
  if (dynamicPrefix === null) return detail;
  const remainder = (dynamicPrefix[1] ?? "")
    .replace(/^[\s.,，。]+/u, "")
    .trim();
  return remainder || undefined;
}

function compactActor(actor: TacticalActorSource | undefined) {
  if (actor === undefined) return undefined;
  return {
    actorGuid: actor.actorGuid,
    name: actor.name,
    class: actor.heroClass,
    hp: [actor.currentHp, actor.maxHp],
    stress: actor.stress,
  };
}

function compactCombatant(combatant: TacticalCombatantSource) {
  return {
    targetGuid: combatant.actorGuid,
    heroGuid: combatant.heroGuid,
    slot: combatant.slot,
    slotEnd:
      combatant.slotEnd === combatant.slot ? undefined : combatant.slotEnd,
    name: combatant.name,
    hp: [combatant.currentHp, combatant.maxHp],
    stress: combatant.stress,
    conditions: combatant.conditions || undefined,
  };
}

function compactTarget(target: TacticalTargetSource | undefined) {
  if (target === undefined) return undefined;
  return {
    side: target.side,
    slot: target.slot,
    slotEnd: target.slotEnd,
    name: target.name,
    currentHp: target.currentHp,
    maxHp: target.maxHp,
    conditions: target.conditions,
  };
}

function noTargetSkill(details: string[]): boolean {
  return /(?:目标\s*(?:无|所有位置)|无需目标|target\s*:?\s*(?:none|all positions)|no\s+target)/iu.test(
    details.join(" "),
  );
}

function partyHealthSummary(party: TacticalCombatantSource[]) {
  const injured = party.filter(
    (hero) =>
      hero.currentHp !== undefined &&
      hero.maxHp !== undefined &&
      hero.currentHp < hero.maxHp,
  );
  return {
    allFull: injured.length === 0,
    injuredCount: injured.length,
    totalMissingHp: injured.reduce(
      (total, hero) => total + Math.max(0, (hero.maxHp ?? 0) - (hero.currentHp ?? 0)),
      0,
    ),
  };
}

function eventIdentity(event: TacticalEventSource): string {
  return JSON.stringify([
    event.tick,
    event.kind,
    event.actorAddress,
    event.resultType,
    event.text,
  ]);
}

function combatantKey(combatant: TacticalCombatantSource): string {
  return (
    (combatant.side === "party" && combatant.heroGuid !== undefined
      ? `hero:${combatant.heroGuid}`
      : undefined) ??
    combatant.actorAddress ??
    `${combatant.side}:${combatant.sideIndex ?? ""}:${combatant.slot}:${combatant.name}`
  );
}

/**
 * Produces a model-facing combat packet. Dynamic facts and the active actor's
 * complete skill text are self-contained on every call. Larger combatant
 * profiles and historical events are emitted only when first seen or changed.
 */
export class TacticalStateProjector {
  private active = false;
  private enemyKeys = new Set<string>();
  private profileSignatures = new Map<string, string>();
  private skillSignatures = new Map<string, string>();
  private seenResults = new Set<string>();
  private seenBuffs = new Set<string>();
  private questSignature = "";

  reset(): void {
    this.active = false;
    this.enemyKeys.clear();
    this.profileSignatures.clear();
    this.skillSignatures.clear();
    this.seenResults.clear();
    this.seenBuffs.clear();
    this.questSignature = "";
  }

  project(state: TacticalStateSource) {
    const combat = state.combat;
    const inCombat =
      combat !== undefined &&
      combat.active !== false &&
      (state.phase === "combat" || state.phase === "targeting");
    if (!inCombat || combat === undefined) {
      this.reset();
      return {
        revision: state.revision,
        observedAt: state.observedAt,
        phase: state.phase,
        context: state.context,
        available: false,
      };
    }

    const currentEnemyKeys = new Set(combat.enemies.map(combatantKey));
    const noEnemyOverlap =
      this.enemyKeys.size > 0 &&
      currentEnemyKeys.size > 0 &&
      [...currentEnemyKeys].every((key) => !this.enemyKeys.has(key));
    const baseline = !this.active || noEnemyOverlap;
    if (baseline) this.reset();
    this.active = true;
    this.enemyKeys = currentEnemyKeys;

    const profileUpdates: Array<{
      side: "party" | "enemy";
      slot: number;
      heroGuid?: number;
      name: string;
      details: string[];
      resists: string[];
      quirks: string[];
      diseases: string[];
    }> = [];
    for (const combatant of [...combat.party, ...combat.enemies]) {
      const details = nonEmpty(combatant.details)
        .map(staticProfileDetail)
        .filter((detail): detail is string => detail !== undefined);
      const resists = nonEmpty(combatant.resists);
      const quirks = nonEmpty(combatant.quirks);
      const diseases = nonEmpty(combatant.diseases);
      const signature = JSON.stringify([
        combatant.name,
        details,
        resists,
        quirks,
        diseases,
      ]);
      const key = combatantKey(combatant);
      if (this.profileSignatures.get(key) !== signature) {
        this.profileSignatures.set(key, signature);
        profileUpdates.push({
          side: combatant.side,
          slot: combatant.slot,
          heroGuid: combatant.heroGuid,
          name: combatant.name,
          details,
          resists,
          quirks,
          diseases,
        });
      }
    }

    const actorKey = combat.actor?.address ?? combat.actor?.name ?? "unknown-actor";
    const skillUpdates: Array<{
      slot?: number;
      name: string;
      details: string[];
    }> = [];
    const skills = combat.skills.map((skill) => {
      const details = nonEmpty(skill.details);
      const key = `${actorKey}:${skill.skillSlot ?? skill.name}`;
      const signature = JSON.stringify([skill.name, details]);
      if (this.skillSignatures.get(key) !== signature) {
        this.skillSignatures.set(key, signature);
        skillUpdates.push({ slot: skill.skillSlot, name: skill.name, details });
      }
      return {
        slot: skill.skillSlot,
        skillElementId: skill.elementId,
        name: skill.name,
        ...(noTargetSkill(details) ? { targetMode: "none" as const } : {}),
      };
    });

    const allResults = combat.recentResults ?? [];
    const recentResults = (baseline ? allResults.slice(-4) : allResults).filter((event) => {
      const identity = eventIdentity(event);
      return baseline || !this.seenResults.has(identity);
    });
    for (const event of allResults) this.seenResults.add(eventIdentity(event));

    const allBuffs = combat.recentBuffs ?? [];
    const recentBuffs = (baseline ? allBuffs.slice(-4) : allBuffs).filter((event) => {
      const identity = eventIdentity(event);
      return baseline || !this.seenBuffs.has(identity);
    });
    for (const event of allBuffs) this.seenBuffs.add(eventIdentity(event));

    const nextQuestSignature = JSON.stringify(state.quest);
    const questUpdate =
      nextQuestSignature !== this.questSignature ? state.quest : undefined;
    this.questSignature = nextQuestSignature;

    return {
      revision: state.revision,
      phase: state.phase,
      context: state.context,
      available: true,
      baseline,
      actor: compactActor(combat.actor),
      partyHealth: partyHealthSummary(combat.party),
      party: combat.party.map(compactCombatant),
      enemies: combat.enemies.map(compactCombatant),
      skills,
      skillUpdates: skillUpdates.length > 0 ? skillUpdates : undefined,
      selectedSkill: combat.selectedSkill ?? state.decision?.selectedSkill,
      currentTarget: compactTarget(
        combat.currentTarget ?? state.decision?.currentTarget,
      ),
      profileUpdates: profileUpdates.length > 0 ? profileUpdates : undefined,
      recentResults: recentResults.length > 0 ? recentResults : undefined,
      recentBuffs: recentBuffs.length > 0 ? recentBuffs : undefined,
      light:
        state.light !== undefined && typeof state.light === "object"
          ? state.light
          : state.light,
      questUpdate,
    };
  }
}
