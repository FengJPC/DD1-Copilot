import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { open, stat } from "node:fs/promises";

export interface TailOptions {
  pollMilliseconds?: number;
  fromStart?: boolean;
  signal?: AbortSignal;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return sleep(milliseconds, undefined, { signal });
}

export async function* tailLogLines(path: string, options: TailOptions = {}): AsyncGenerator<string> {
  const pollMilliseconds = options.pollMilliseconds ?? 100;
  let offset = 0;
  let carry = "";
  let decoder = new StringDecoder("utf8");
  let initialized = false;

  while (!options.signal?.aborted) {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      await delay(pollMilliseconds, options.signal);
      continue;
    }

    if (!initialized) {
      offset = options.fromStart === true ? 0 : size;
      initialized = true;
    } else if (size < offset) {
      offset = 0;
      carry = "";
      decoder = new StringDecoder("utf8");
    }

    if (size > offset) {
      const length = Math.min(1024 * 1024, size - offset);
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const chunks = (carry + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/u);
        carry = chunks.pop() ?? "";
        for (const line of chunks) {
          if (line !== "") yield line;
        }
      } finally {
        await handle.close();
      }
    }

    await delay(pollMilliseconds, options.signal);
  }
}
