import type { CommandAcknowledgement, CommandHealth, CommandTransport, GameCommand } from '../../src/command/transport.js';

export class FakeCommandTransport implements CommandTransport {
  sendCount = 0;
  commands: GameCommand[] = [];

  constructor(
    private readonly onSend: (command: GameCommand) => Promise<void>,
  ) { }

  async health(): Promise<CommandHealth> {
    return {
      configured: true,
      available: true,
      transport: "named_pipe",
    };
  }

  async send(command: GameCommand): Promise<CommandAcknowledgement> {
    this.sendCount += 1;
    this.commands.push(command);
    await this.onSend(command);
    return {
      commandId: `fake-${this.sendCount}`,
      transport: "named_pipe",
      status: "queued",
      receivedAt: new Date().toISOString(),
    };
  }
}
