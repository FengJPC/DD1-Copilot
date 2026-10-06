import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, 'build');
const target = join(build, 'dd1-copilot');
const staging = join(build, `.dd1-plugin-${randomUUID()}`);
function insideBuild(path) {
  const rel = relative(build, resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plugin output must remain inside the project build directory.');
  return path;
}
async function runNode(args) {
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error(`Plugin compile failed (${code}).`)));
  });
}
async function moveGenerated(source, destination) {
  insideBuild(source); insideBuild(destination);
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(200 * (attempt + 1));
    }
  }
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Plugin packages cannot include symbolic links.');
    const path = join(directory, item.name);
    const name = `${prefix}${item.name}`;
    if (item.isDirectory()) files.push(...await inventory(path, `${name}/`));
    else {
      if (/\.(?:dll|exe|jar|sqlite|db|log)$/iu.test(name) || /(?:^|\/)(?:\.env|[^/]*\.local\.json)$/u.test(name)) throw new Error(`Private or executable artifact in plugin package: ${name}`);
      const content = await readFile(path);
      files.push({ path: name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer.');
  await mkdir(insideBuild(staging), { recursive: true });
  const template = join(root, 'plugins', 'dd1-copilot');
  for (const name of ['plugin.json', 'mcp.json', '.codex-plugin', '.mcp.json', 'scripts', 'skills']) {
    await cp(join(template, name), join(staging, name), { recursive: true });
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(staging, name));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const manifest of ['plugin.json', '.codex-plugin/plugin.json']) {
    const path = join(staging, manifest);
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.version = pkg.version;
    await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  }
  const runtime = join(staging, 'runtime');
  await mkdir(runtime);
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'dd1-copilot-runtime', version: pkg.version, private: true,
    type: 'module', license: 'MIT', engines: { node: '>=24' }, dependencies: pkg.dependencies }, null, 2) + '\n');
  await runNode([join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', join(runtime, 'dist'), '--declaration', 'false', '--sourceMap', 'false']);
  // The lock selects the entire production graph; never copy the checkout or all node_modules.
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const dependencies = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    if (!path.startsWith('node_modules/') || path.includes('..')) throw new Error(`Unsupported production dependency path: ${path}`);
    const installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
    if (installed.version !== entry.version) throw new Error(`Run npm ci; installed dependency differs from lock: ${path}`);
    const destination = join(runtime, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, path), destination, { recursive: true, dereference: false });
    dependencies.push({ name: installed.name, version: entry.version, license: entry.license, integrity: entry.integrity });
  }
  const files = await inventory(staging);
  await writeFile(join(staging, 'package-contents.json'), JSON.stringify({ version: pkg.version, dependencies, files }, null, 2) + '\n');
  insideBuild(target);
  const previous = insideBuild(join(build, `.dd1-previous-${randomUUID()}`));
  const hadPrevious = existsSync(target);
  if (hadPrevious) await moveGenerated(target, previous);
  try { await moveGenerated(staging, target); } catch (error) {
    if (hadPrevious) await moveGenerated(previous, target);
    throw error;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
  console.log(JSON.stringify({ package: target, version: pkg.version, files: files.length, dependencies: dependencies.map(row => row.name),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
} catch (error) {
  await rm(insideBuild(staging), { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
