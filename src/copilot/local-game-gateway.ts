import type { CommandTransport, GameCommand } from "../command/transport.js";
import type {
  BlindestLogRecord,
  CombatLogSnapshot,
  CombatLogSource,
} from "../live/combat-log-source.js";
import type { GameGateway } from "./types.js";

export class LocalGameGateway implements GameGateway {
  constructor(
    private readonly log: CombatLogSource,
    private readonly command: CommandTransport,
  ) {}

  refresh(): Promise<CombatLogSnapshot> {
    return this.log.refresh();
  }

  recordsAfter(revision: number, limit = 200): BlindestLogRecord[] {
    return this.log.recordsAfter(revision, limit);
  }

  send(command: GameCommand) {
    return this.command.send(command);
  }
}
