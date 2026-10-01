import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseInventory(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^event: scroll opened, skin=(\d+) rows=(\d+) title="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_opened",
      skin: Number(match[1]),
      rowCount: Number(match[2]),
      title: match[3] ?? "",
    };
  }

  if (line.message === "event: scroll closed") {
    return { ...base, kind: "event_closed" };
  }

  match = /^event: activating "([^"]*)" (?:by CLICKING its element(?: 0x[0-9a-f]+)?|via native action 0x[0-9a-f]+ \(cap=[^)]+\))$/iu.exec(
    line.message,
  );
  if (match) {
    return { ...base, kind: "event_option_activated", name: match[1] ?? "" };
  }

  match = /^agent-state: inventory begin slots=(\d+) occupied=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "inventory_snapshot_started",
      slotCount: Number(match[1]),
      occupiedCount: Number(match[2]),
    };
  }

  match = /^agent-state: inventory slot=(\d+) amount=(\d+) type="([^"]*)" item_id="([^"]*)" key="([^"]*)" name="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "inventory_item_observed",
      slot: Number(match[1]),
      amount: Number(match[2]),
      itemType: match[3] ?? "",
      itemId: match[4] ?? "",
      itemKey: match[5] ?? "",
      name: match[6] ?? "",
    };
  }

  if (line.message === "agent-state: inventory end") {
    return { ...base, kind: "inventory_snapshot_completed" };
  }

  match = /^agent-state: event begin skin=(\d+) rows=(\d+) pick_item=(\d+) title="([^"]*)" flavour="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_snapshot_started",
      skin: Number(match[1]),
      rowCount: Number(match[2]),
      pickingItem: match[3] === "1",
      title: match[4] ?? "",
      flavour: match[5] ?? "",
    };
  }

  match = /^agent-state: event row=(\d+) name="([^"]*)" desc="([^"]*)" item_slot=(\d+) enabled=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_option_observed",
      optionIndex: Number(match[1]),
      name: match[2] ?? "",
      description: match[3] ?? "",
      itemSlot: match[4] === "1",
      enabled: match[5] === "1",
    };
  }

  match = /^agent-state: event item slot=(\d+) works=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "event_item_compatibility_observed",
      slot: Number(match[1]),
      works: match[2] === "1",
    };
  }

  if (line.message === "agent-state: event end") {
    return { ...base, kind: "event_snapshot_completed" };
  }

  match = /^agent-state: loot begin count=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loot_snapshot_started",
      itemCount: Number(match[1]),
    };
  }

  match = /^agent-state: loot item=(\d+) pool_slot=(\d+) amount=(\d+) type="([^"]*)" item_id="([^"]*)" key="([^"]*)" name="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "loot_item_observed",
      itemIndex: Number(match[1]),
      poolSlot: Number(match[2]),
      amount: Number(match[3]),
      itemType: match[4] ?? "",
      itemId: match[5] ?? "",
      itemKey: match[6] ?? "",
      name: match[7] ?? "",
    };
  }

  if (line.message === "agent-state: loot end") {
    return { ...base, kind: "loot_snapshot_completed" };
  }

  match = /^agent-state: light kind=(torch|ambient) value=([-\d.]+) level=(-?\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "light_observed",
      lightKind: match[1] === "ambient" ? "ambient" : "torch",
      value: Number(match[2]),
      level: Number(match[3]),
      text: match[4] ?? "",
    };
  }

  match = /^loot: window opened, (\d+) items?, token="([^"]*)"/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loot_opened",
      itemCount: Number(match[1]),
      token: match[2] ?? "",
    };
  }

  if (/^loot: window closed$/u.test(line.message)) {
    return { ...base, kind: "loot_closed" };
  }

  match = /^agent-event: inventory_consolidated merges=(\d+) freed=(\d+) accepted=(\d+)(?: reason=\S+)?$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "inventory_consolidated",
      merges: Number(match[1]),
      freed: Number(match[2]),
      accepted: match[3] === "1",
    };
  }
  return undefined;
}
