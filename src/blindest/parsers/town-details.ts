import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseTownDetails(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let m: RegExpExecArray | null;
  m = /^agent-town: capabilities upgrades=([01])$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_capabilities_observed', canUpgrade: m[1] === '1' };
  m = /^agent-town: shop_currency id="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_shop_currency_observed', currency: m[1] ?? '' };
  m = /^agent-town: roster_capacity count=(\d+) capacity=(\d+)$/u.exec(line.message);
  if (m) return { ...base, kind: 'roster_capacity_observed', rosterCount: Number(m[1]), rosterCapacity: Number(m[2]) };
  m = /^agent-town: recruit_profile hero=([0-9a-f]+) class="([^"]*)" level=(-?\d+) health="([^"]*)" stress="([^"]*)"$/iu.exec(line.message);
  if (m) return { ...base, kind: 'recruit_profile_observed', heroAddress: m[1]!.toUpperCase(), heroClass: m[2] ?? '', level: Number(m[3]), healthText: m[4] ?? '', stressText: m[5] ?? '' };
  m = /^agent-town: recruit_detail hero=([0-9a-f]+) category=(quirk|disease) line=(\d+) text="([^"]*)"$/iu.exec(line.message);
  if (m) return { ...base, kind: 'recruit_detail_observed', heroAddress: m[1]!.toUpperCase(), category: m[2] as 'quirk' | 'disease', line: Number(m[3]), text: m[4] ?? '' };
  m = /^agent-town: activity_candidate id="([^"]*)" slot=(\d+) guid=(\d+) name="([^"]*)" known=([01]) eligible=([01]) affordable=([01]) price_known=([01]) price=(-?\d+) currency="([^"]*)" reason="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_activity_candidate_observed', activityId: m[1] ?? '', slot: Number(m[2]), heroGuid: Number(m[3]), name: m[4] ?? '', known: m[5] === '1', eligible: m[6] === '1', affordable: m[7] === '1', priceKnown: m[8] === '1', price: Number(m[9]), currency: m[10] ?? '', reason: m[11] ?? '' };
  m = /^agent-town: activity_kind id="([^"]*)" slot=(\d+) treatment=([01])$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_activity_kind_observed', activityId: m[1] ?? '', slot: Number(m[2]), treatment: m[3] === '1' };
  m = /^agent-town: treatment id="([^"]*)" slot=(\d+) quirk="([^"]*)" mode=([12]) name="([^"]*)" chosen=([01]) price_known=([01]) price=(-?\d+) currency="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'town_treatment_observed', activityId: m[1] ?? '', slot: Number(m[2]), quirkId: m[3] ?? '', mode: Number(m[4]), name: m[5] ?? '', chosen: m[6] === '1', priceKnown: m[7] === '1', price: Number(m[8]), currency: m[9] ?? '' };
  m = /^agent-town: hero_step option="([^"]*)" code=(.) available=([01]) cost_known=([01]) reason="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_hero_step_metadata_observed', optionId: m[1] ?? '', code: m[2] ?? '', available: m[3] === '1', costKnown: m[4] === '1', lockReason: m[5] ?? '' };
  m = /^agent-town: cost owner=(hero|facility) id="([^"]*)" code=(.) currency="([^"]*)" amount=(\d+)$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_cost_observed', owner: m[1] as 'hero' | 'facility', id: m[2] ?? '', code: m[3] ?? '', currency: m[4] ?? '', amount: Number(m[5]) };
  m = /^agent-town: hero_effect option="([^"]*)" column=(\d+) line=(\d+) text="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_hero_effect_observed', optionId: m[1] ?? '', column: Number(m[2]), line: Number(m[3]), text: m[4] ?? '' };
  m = /^agent-town: facility track=(\d+) available=([01]) cost_known=([01]) source=registry text="([^"]*)"$/u.exec(line.message);
  if (m) return { ...base, kind: 'building_facility_metadata_observed', track: Number(m[1]), available: m[2] === '1', costKnown: m[3] === '1', description: m[4] ?? '' };
  return undefined;
}
