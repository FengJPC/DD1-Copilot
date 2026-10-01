import { open } from "node:fs/promises";

import type { BlindestEvent } from "../blindest/events.js";
import {
  parseBlindestLine,
  parseLogEnvelope,
} from "../blindest/parse-line.js";
import {
  initialGameState,
  reduceGameState,
  type GameState,
} from "../state/game-state.js";

export interface BlindestLogRecord {
  revision: number;
  observedAt: string;
  raw: string;
  tick?: number;
  message?: string;
  event?: BlindestEvent;
}

export interface CombatLogSnapshot {
  revision: number;
  observedAt: string;
  state: GameState;
  source: {
    kind: "blindest_log";
    path: string;
    available: boolean;
    bytesConsumed: number;
    fileSize?: number;
    earliestBufferedRevision?: number;
    latestRevision: number;
    parsedEventCount: number;
    error?: string;
  };
}

export class CombatLogSource {
  private offset = 0;
  private inFlight?: Promise<CombatLogSnapshot>;
  private fileIdentity?: string;
  private consumedAnchor = Buffer.alloc(0);
  private revision = 0;
  private state = initialGameState();
  private readonly recentRecords: BlindestLogRecord[] = [];

  constructor(
    readonly path: string,
    private readonly recentRecordLimit = 2_000,
  ) { }

  refresh(): Promise<CombatLogSnapshot> {
    // MCP reads, action verification and transition waits share one log cursor.
    if (this.inFlight) return this.inFlight;
    const pending = this.refreshOnce();
    this.inFlight = pending;
    return pending.finally(() => { this.inFlight = undefined; });
  }

  private async refreshOnce(): Promise<CombatLogSnapshot> {
    const observedAt = new Date().toISOString();
    let fileSize: number | undefined;
    try {
      const handle = await open(this.path, "r");
      try {
        const metadata = await handle.stat();
        fileSize = metadata.size;
        const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
        let replaced = this.fileIdentity !== undefined && this.fileIdentity !== identity;
        // Also detect truncate-and-regrow on the same inode between polls.
        if (!replaced && this.offset > 0 && fileSize >= this.offset) {
          const probe = Buffer.alloc(this.consumedAnchor.length);
          const { bytesRead } = await handle.read(probe, 0, probe.length, this.offset - probe.length);
          replaced = bytesRead !== probe.length || !probe.equals(this.consumedAnchor);
        }
        if (replaced || fileSize < this.offset) this.reset();
        this.fileIdentity = identity;
        const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, fileSize - this.offset)));
        while (this.offset < fileSize) {
          const length = Math.min(buffer.length, fileSize - this.offset);
          const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
          if (bytesRead === 0) break;
          const read = buffer.subarray(0, bytesRead);
          const lastNewline = read.lastIndexOf(0x0a);
          if (lastNewline < 0) {
            if (bytesRead === 1024 * 1024) throw new Error("Log line exceeds the 1 MiB read limit.");
            break; // Incomplete UTF-8/line bytes stay on disk until the next poll.
          }
          const complete = read.subarray(0, lastNewline + 1);
          this.offset += complete.length;
          this.consumedAnchor = Buffer.from(complete.subarray(-64));
          this.consume(complete.toString("utf8"), observedAt);
        }
      } finally { await handle.close(); }
      return this.snapshot(observedAt, true, fileSize);
    } catch (error) {
      return this.snapshot(observedAt, false, fileSize, error);
    }
  }

  recordsAfter(revision = 0, limit = 200): BlindestLogRecord[] {
    return this.recentRecords
      .filter((entry) => entry.revision > revision)
      .slice(-Math.max(1, Math.min(limit, this.recentRecordLimit)));
  }

  private consume(text: string, observedAt: string): void {
    for (const line of text.split(/\r?\n/u)) {
      if (line === "") continue;
      this.revision += 1;
      const envelope = parseLogEnvelope(line);
      const event = parseBlindestLine(line);
      if (event) this.state = reduceGameState(this.state, event);

      this.recentRecords.push({
        revision: this.revision,
        observedAt,
        raw: line,
        ...(envelope === undefined
          ? {}
          : { tick: envelope.tick, message: envelope.message }),
        ...(event === undefined ? {} : { event }),
      });
    }

    if (this.recentRecords.length > this.recentRecordLimit) {
      this.recentRecords.splice(
        0,
        this.recentRecords.length - this.recentRecordLimit,
      );
    }
  }

  private reset(): void {
    this.offset = 0;
    this.revision += 1; // Revision is monotonic across file generations.
    this.consumedAnchor = Buffer.alloc(0);
    this.state = initialGameState();
    this.recentRecords.length = 0;
  }

  private snapshot(
    observedAt: string,
    available: boolean,
    fileSize?: number,
    error?: unknown,
  ): CombatLogSnapshot {
    return {
      revision: this.revision,
      observedAt,
      state: structuredClone(this.state),
      source: {
        kind: "blindest_log",
        path: this.path,
        available,
        bytesConsumed: this.offset,
        ...(fileSize === undefined ? {} : { fileSize }),
        ...(this.recentRecords[0] === undefined
          ? {}
          : { earliestBufferedRevision: this.recentRecords[0].revision }),
        latestRevision: this.revision,
        parsedEventCount: this.state.eventCount,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      },
    };
  }
}
