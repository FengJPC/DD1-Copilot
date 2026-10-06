import { randomUUID } from 'node:crypto';
import type { CommandTransport, GameCommand } from '../command/transport.js';
import { acquireRuntimeLease } from './runtime-lease.js';

/** MCP discovery is unrestricted; game input stays owned by one session. */
export class LeasedCommandTransport implements CommandTransport {
  private acquiring?: Promise<void>;
  private releaseLease?: () => Promise<void>;
  private closed = false;

  constructor(private readonly command: CommandTransport, private readonly pipePath: string) { }

  health() { return this.command.health(); }

  async send(command: GameCommand) {
    try {
      if (this.closed) throw new Error('DD1 command session is closed. No input was sent.');
      if (!this.releaseLease) {
        this.acquiring ??= acquireRuntimeLease(this.pipePath).then(release => { this.releaseLease = release; });
        try { await this.acquiring; } finally { this.acquiring = undefined; }
      }
      if (this.closed) throw new Error('DD1 command session is closed. No input was sent.');
    } catch (error) {
      return { commandId: randomUUID(), transport: 'named_pipe' as const, status: 'rejected' as const,
        receivedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) };
    }
    return this.command.send(command);
  }

  async close() {
    this.closed = true;
    await this.acquiring?.catch(() => { });
    const release = this.releaseLease;
    this.releaseLease = undefined;
    await release?.();
  }
}
