import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface SaveFileSnapshot {
  name: string;
  length: number;
  lastWriteTime: string;
  sha256?: string;
  decoded?: unknown;
  error?: string;
}

export interface LiveSaveSnapshot {
  revision: number;
  observedAt: string;
  source: {
    kind: "save_directory";
    path: string;
    available: boolean;
    fileCount: number;
    error?: string;
  };
  files: Record<string, SaveFileSnapshot>;
}

export interface SaveSourceHealth {
  kind: "save_directory";
  path: string;
  configured: true;
  available: boolean;
  discoveredFileCount: number;
  cachedRevision: number;
  cachedFileCount: number;
  error?: string;
}

export interface LiveSaveSourceOptions {
  saveDirectory: string;
  decoderJar: string;
  javaExecutable?: string;
  cacheDirectory?: string;
}

interface CachedSaveFile extends SaveFileSnapshot {
  signature: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runDecoder(
  javaExecutable: string,
  jarPath: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await new Promise<void>((resolveProcess, reject) => {
    const child = spawn(
      javaExecutable,
      ["-jar", jarPath, "decode", "--output", outputPath, inputPath],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 30_000 },
    );
    const stderr: Buffer[] = [];
    let diagnosticBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, 64 * 1024 - diagnosticBytes));
      diagnosticBytes += retained.length;
      if (retained.length) stderr.push(retained);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `DDSaveEditor exited with code ${String(code)}${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
    });
  });
}

async function stableRead(path: string): Promise<{
  data: Buffer;
  length: number;
  lastWriteTime: string;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const before = await stat(path);
      const data = await readFile(path);
      const after = await stat(path);
      if (
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        data.length === after.size
      ) {
        return {
          data,
          length: after.size,
          lastWriteTime: after.mtime.toISOString(),
        };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Could not obtain a stable save read: ${lastError instanceof Error ? lastError.message : String(lastError ?? "file kept changing")}`,
  );
}

export class LiveSaveSource {
  private revision = 0;
  private readonly files = new Map<string, CachedSaveFile>();
  private preparedJar?: string;
  private readonly cacheDirectory: string;

  constructor(private readonly options: LiveSaveSourceOptions) {
    this.cacheDirectory = resolve(
      options.cacheDirectory ?? join(tmpdir(), "DD1AgentBridge", "mcp-save-cache"),
    );
  }

  async health(): Promise<SaveSourceHealth> {
    const path = resolve(this.options.saveDirectory);
    try {
      const discoveredFileCount = (
        await readdir(path, { withFileTypes: true })
      ).filter(
        (entry) => entry.isFile() && /^persist\..+\.json$/u.test(entry.name),
      ).length;
      return {
        kind: "save_directory",
        path,
        configured: true,
        available: true,
        discoveredFileCount,
        cachedRevision: this.revision,
        cachedFileCount: this.files.size,
      };
    } catch (error) {
      return {
        kind: "save_directory",
        path,
        configured: true,
        available: false,
        discoveredFileCount: 0,
        cachedRevision: this.revision,
        cachedFileCount: this.files.size,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async refresh(): Promise<LiveSaveSnapshot> {
    const observedAt = new Date().toISOString();
    let names: string[];
    try {
      names = (await readdir(resolve(this.options.saveDirectory), { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() && /^persist\..+\.json$/u.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      return this.snapshot(observedAt, false, error);
    }

    const present = new Set(names);
    let changed = false;
    for (const cachedName of this.files.keys()) {
      if (!present.has(cachedName)) {
        this.files.delete(cachedName);
        changed = true;
      }
    }

    await mkdir(this.cacheDirectory, { recursive: true });
    const jarPath = await this.prepareDecoderJar();

    for (const name of names) {
      const sourcePath = join(resolve(this.options.saveDirectory), name);
      let currentStat;
      try {
        currentStat = await stat(sourcePath);
      } catch (error) {
        this.files.set(name, {
          name,
          length: 0,
          lastWriteTime: observedAt,
          signature: `error:${observedAt}`,
          error: error instanceof Error ? error.message : String(error),
        });
        changed = true;
        continue;
      }

      const signature = `${currentStat.size}:${currentStat.mtimeMs}`;
      if (this.files.get(name)?.signature === signature) continue;

      try {
        const stable = await stableRead(sourcePath);
        const sha256 = createHash("sha256").update(stable.data).digest("hex");
        const token = randomUUID();
        const snapshotPath = join(this.cacheDirectory, `${token}-${name}`);
        const decodedPath = join(this.cacheDirectory, `${token}-${name}.decoded.json`);
        try {
          await writeFile(snapshotPath, stable.data);
          await runDecoder(
            this.options.javaExecutable ?? "java",
            jarPath,
            snapshotPath,
            decodedPath,
          );
          const decoded = JSON.parse(
            await readFile(decodedPath, "utf8"),
          ) as unknown;
          this.files.set(name, {
            name,
            length: stable.length,
            lastWriteTime: stable.lastWriteTime,
            sha256,
            decoded,
            signature,
          });
        } finally {
          await Promise.allSettled([
            rm(snapshotPath, { force: true }),
            rm(decodedPath, { force: true }),
          ]);
        }
      } catch (error) {
        this.files.set(name, {
          name,
          length: currentStat.size,
          lastWriteTime: currentStat.mtime.toISOString(),
          signature,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      changed = true;
    }

    if (changed) this.revision += 1;
    return this.snapshot(observedAt, true);
  }

  private async prepareDecoderJar(): Promise<string> {
    if (this.preparedJar !== undefined) return this.preparedJar;
    const source = resolve(this.options.decoderJar);
    const target = join(this.cacheDirectory, "DDSaveEditor.jar");
    await copyFile(source, target);
    this.preparedJar = target;
    return target;
  }

  private snapshot(
    observedAt: string,
    available: boolean,
    error?: unknown,
  ): LiveSaveSnapshot {
    const files = Object.fromEntries(
      [...this.files.entries()].map(([name, value]) => {
        const { signature: _signature, ...snapshot } = value;
        return [name, structuredClone(snapshot)];
      }),
    );
    return {
      revision: this.revision,
      observedAt,
      source: {
        kind: "save_directory",
        path: resolve(this.options.saveDirectory),
        available,
        fileCount: Object.keys(files).length,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      },
      files,
    };
  }
}
