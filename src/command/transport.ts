import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export interface GameCommand {
  kind: string;
  args: Record<string, unknown>;
}

export interface CommandEnvelope {
  protocolVersion: 1;
  commandId: string;
  sentAt: string;
  command: GameCommand;
}

export interface CommandAcknowledgement {
  commandId: string;
  transport: "named_pipe" | "unavailable";
  status: "accepted" | "queued" | "rejected" | "unavailable" | "timeout";
  receivedAt: string;
  reason?: string;
}

export interface CommandHealth {
  configured: boolean;
  available: boolean;
  transport: "named_pipe" | "unavailable";
  endpoint?: string;
  error?: string;
}

export interface CommandTransport {
  health(): Promise<CommandHealth>;
  send(command: GameCommand): Promise<CommandAcknowledgement>;
}

export class UnavailableCommandTransport implements CommandTransport {
  async health(): Promise<CommandHealth> {
    return {
      configured: false,
      available: false,
      transport: "unavailable",
      error: "DD1_COMMAND_PIPE is not configured.",
    };
  }

  async send(): Promise<CommandAcknowledgement> {
    return {
      commandId: randomUUID(),
      transport: "unavailable",
      status: "unavailable",
      receivedAt: new Date().toISOString(),
      reason: "DD1_COMMAND_PIPE is not configured.",
    };
  }
}

export class NamedPipeCommandTransport implements CommandTransport {
  constructor(
    private readonly pipePath: string,
    private readonly timeoutMilliseconds = 2_000,
  ) {}

  async health(): Promise<CommandHealth> {
    return new Promise((resolveHealth) => {
      const socket = createConnection(this.pipePath);
      let finished = false;
      const finish = (result: CommandHealth) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolveHealth(result);
      };
      const timer = setTimeout(
        () =>
          finish({
            configured: true,
            available: false,
            transport: "named_pipe",
            endpoint: this.pipePath,
            error: "Connection timed out.",
          }),
        this.timeoutMilliseconds,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        finish({
          configured: true,
          available: true,
          transport: "named_pipe",
          endpoint: this.pipePath,
        });
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        finish({
          configured: true,
          available: false,
          transport: "named_pipe",
          endpoint: this.pipePath,
          error: error.message,
        });
      });
    });
  }

  async send(command: GameCommand): Promise<CommandAcknowledgement> {
    const envelope: CommandEnvelope = {
      protocolVersion: 1,
      commandId: randomUUID(),
      sentAt: new Date().toISOString(),
      command,
    };

    return new Promise((resolveAck) => {
      const socket = createConnection(this.pipePath);
      let finished = false;
      let response = "";
      let sent = false;
      const finish = (ack: CommandAcknowledgement) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolveAck(ack);
      };
      const timer = setTimeout(
        () =>
          finish({
            commandId: envelope.commandId,
            transport: "named_pipe",
            status: "timeout",
            receivedAt: new Date().toISOString(),
            reason: "No command acknowledgement arrived before timeout.",
          }),
        this.timeoutMilliseconds,
      );

      socket.once("connect", () => {
        sent = true;
        socket.write(`${JSON.stringify(envelope)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
        const newline = response.indexOf("\n");
        if (response.length > 64 * 1024) {
          clearTimeout(timer);
          finish({ commandId: envelope.commandId, transport: "named_pipe", status: "timeout",
            receivedAt: new Date().toISOString(), reason: "Oversized acknowledgement; command outcome is unknown." });
          return;
        }
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(response.slice(0, newline)) as Partial<
            CommandAcknowledgement & { commandId: string }
          >;
          if (parsed.commandId !== envelope.commandId) {
            throw new Error("Acknowledgement commandId did not match the request.");
          }
          const status = parsed.status;
          if (status !== "accepted" && status !== "queued" && status !== "rejected") {
            throw new Error("Acknowledgement contained an invalid status.");
          }
          finish({
            commandId: envelope.commandId,
            transport: "named_pipe",
            status,
            receivedAt: new Date().toISOString(),
            ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
          });
        } catch (error) {
          finish({
            commandId: envelope.commandId,
            transport: "named_pipe",
            status: "timeout",
            receivedAt: new Date().toISOString(),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        finish({
          commandId: envelope.commandId,
          transport: "named_pipe",
          status: sent ? "timeout" : "unavailable",
          receivedAt: new Date().toISOString(),
          reason: error.message,
        });
      });
    });
  }
}
