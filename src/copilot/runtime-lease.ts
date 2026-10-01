import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One controlling process per game command pipe, across both entry points. */
export async function acquireRuntimeLease(commandPipe: string): Promise<() => Promise<void>> {
  const identity = process.platform === 'win32' ? commandPipe.toLowerCase() : commandPipe;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\dd1-copilot-owner-${key}`
    : join(tmpdir(), `dd1-copilot-owner-${key}.sock`);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error('A DD1 Copilot process already owns this game command pipe. Stop it before starting another.')
        : error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => { server.off('error', onError); resolve(); });
  });
  let closed = false;
  return () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}
