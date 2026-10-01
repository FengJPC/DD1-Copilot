import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseSession(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^axcontext -> ([a-z_]+)$/u.exec(line.message);
  if (match) return { ...base, kind: "context_changed", context: match[1] ?? "unknown" };

  match = /^confirmpopup dev=\S+ alt=\d+ entry=0x[0-9a-f]+ count=(\d+) got=(\d+) btn0=-?\d+ btn1=-?\d+ text="(.*)"$/iu.exec(line.message);
  if (match) {
    const text = match[3] ?? '';
    const answerCount = Number(match[1]);
    // Keep the entire live readout even when answer labels cannot be separated.
    // The DLL's two-answer format is "<question> <hint>, <label>. <hint>, <label>.".
    const answers = answerCount === 2 && Number(match[2]) === 2
      ? / ([^,. ]+), ([^.]+)\. ([^,. ]+), ([^.]+)\.$/u.exec(text) : null;
    return {
      ...base, kind: 'confirmation_dialog_observed', text, answerCount,
      options: answers ? [0, 1].map((optionIndex) => ({
        optionIndex, inputHint: answers[1 + optionIndex * 2]!, label: answers[2 + optionIndex * 2]!,
        // Source/Mod/src/game/offsets.h: CONFIRM_ANSWER_BASE + answer index.
        elementId: `0x${(0x636e6661 + optionIndex).toString(16)}`,
      })) : [],
    };
  }

  match = /^tutorialpopup id=([^ ]+) text="(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "tutorial_opened",
      tutorialId: match[1] ?? "unknown",
      text: match[2] ?? "",
    };
  }

  match = /^(?:tutorial closed; context "([^"]+)" does not re-announce|tutorial closed -> handing focus back to "([^"]+)")$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "tutorial_closed",
      context: match[1] ?? match[2] ?? "unknown",
    };
  }

  if (line.message === "agent-state: begin") {
    return { ...base, kind: "agent_state_started" };
  }

  if (line.message === "agent-state: end") {
    return { ...base, kind: "agent_state_completed" };
  }
  return undefined;
}
