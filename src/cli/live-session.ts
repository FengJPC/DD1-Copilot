import { createInterface } from 'node:readline';
import { NamedPipeCommandTransport } from '../command/transport.js';
import { CampaignMemoryStore } from '../copilot/campaign-memory.js';
import { CopilotEngine } from '../copilot/engine.js';
import { LiveRequestHandler } from '../copilot/live-handler.js';
import { LocalGameGateway } from '../copilot/local-game-gateway.js';
import { registerProcessShutdown } from '../copilot/process-lifecycle.js';
import { acquireRuntimeLease } from '../copilot/runtime-lease.js';
import { CopilotSession } from '../copilot/session.js';
import { CombatLogSource } from '../live/combat-log-source.js';

export async function runLiveSession(): Promise<void> {
  const logPath = process.env.DD1_BLINDEST_LOG?.trim();
  const pipePath = process.env.DD1_COMMAND_PIPE?.trim();
  if (!logPath || !pipePath) throw new Error('DD1_BLINDEST_LOG and DD1_COMMAND_PIPE must be configured.');
  const release = await acquireRuntimeLease(pipePath);
  let session: CopilotSession | undefined;
  let removeListeners = () => { };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const previousRawMode = process.stdin.isRaw;
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    session?.close();
    input.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(previousRawMode ?? false);
    process.stdin.pause();
  };
  const controlInput = (chunk: Buffer) => {
    if (process.stdin.isTTY && (chunk.includes(3) || chunk.includes(4))) shutdown();
  };
  const reply = (id: string, payload: Record<string, unknown>) => {
    if (!closed) process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`);
  };
  try {
    session = new CopilotSession(new CopilotEngine(new LocalGameGateway(
      new CombatLogSource(logPath), new NamedPipeCommandTransport(pipePath, 3_000),
    )), CampaignMemoryStore.fromEnvironment());
    const handler = new LiveRequestHandler(session);
    removeListeners = registerProcessShutdown(shutdown);
    process.stdin.on('data', controlInput);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    reply('startup', { ready: true, memory: session.memory.getStatus() });
    for await (const line of input) {
      if (closed) break;
      if (!line.trim()) continue;
      let id = 'parse';
      const startedAt = Date.now();
      try {
        const request: unknown = JSON.parse(line.trim());
        if (request && typeof request === 'object' && 'id' in request) id = String(request.id);
        else id = 'request';
        const result = await handler.handle(request);
        reply(id, { ok: true, elapsedMs: Date.now() - startedAt, ...result });
        if (result.stopped) break;
      } catch (error) {
        reply(id, {
          ok: false, elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    shutdown();
    removeListeners();
    process.stdin.off('data', controlInput);
    await release();
  }
}
