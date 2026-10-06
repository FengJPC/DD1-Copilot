#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPluginConfiguration } from './configuration.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('DD1 Copilot requires Node.js 24 or newer (built-in SQLite).');
  const entry = new URL('../runtime/dist/copilot/stdio.js', import.meta.url);
  if (!existsSync(entry)) throw new Error('DD1 plugin runtime is missing. Run npm run plugin:package and install the built package.');
  const configured = readPluginConfiguration();
  Object.assign(process.env, configured.env);
  // Resolve and check a binding without registering it or opening/writing SQLite.
  const { resolveMemoryConfiguration } = await import('../runtime/dist/copilot/memory/storage-config.js');
  const memory = resolveMemoryConfiguration();
  if (!memory.saveDirectory) throw new Error('The DD1 plugin requires a bound saveDirectory; campaign-ID-only mode is reserved for tests.');
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ ok: true, nodeVersion: process.versions.node, runtime: fileURLToPath(entry), campaignId: memory.campaignId,
      logAvailable: configured.logAvailable, databaseExists: existsSync(memory.path), gameConnection: 'not_probed' }));
  } else {
    // Keep stdout exclusively for MCP; the existing runtime owns EOF/signals/leases.
    await import(entry.href);
  }
} catch (error) {
  console.error(`[DD1 Copilot] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
