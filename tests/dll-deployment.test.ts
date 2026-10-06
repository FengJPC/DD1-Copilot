import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
for (const scenario of ['valid', 'source_changed', 'source_added', 'binary_changed', 'path_escape', 'duplicate_path'] as const) {
  test(`DLL deployment validates provenance before replacing anything: ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dd1-deploy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scripts = join(root, 'scripts');
    const mod = join(root, 'references', 'Blindest-Dungeon', 'Source', 'Mod');
    const source = join(mod, 'src'); const build = join(mod, 'build'); const game = join(root, 'game');
    for (const path of [scripts, source, build, game]) await mkdir(path, { recursive: true });
    await copyFile('scripts/deploy_agent_dll.ps1', join(scripts, 'deploy_agent_dll.ps1'));
    await writeFile(join(source, 'bridge.cpp'), 'source');
    await writeFile(join(build, 'ddaccess.dll'), 'new');
    await writeFile(join(game, 'ddaccess.dll'), 'previous');
    const nativeSources = [{ path: 'bridge.cpp', sha256: hash('source') }];
    if (scenario === 'source_changed') await writeFile(join(source, 'bridge.cpp'), 'changed');
    if (scenario === 'source_added') await writeFile(join(source, 'new.inc'), 'new source');
    if (scenario === 'binary_changed') await writeFile(join(build, 'ddaccess.dll'), 'changed');
    if (scenario === 'path_escape') nativeSources[0]!.path = '../outside.cpp';
    if (scenario === 'duplicate_path') {
      nativeSources.push({ ...nativeSources[0]! });
      await writeFile(join(source, 'unlisted.cpp'), 'unlisted');
    }
    await writeFile(join(build, 'ddaccess.build.json'), JSON.stringify({ version: 1, sha256: hash('new'), nativeSources }));
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      // Windows PowerShell must rebuild its module path rather than inherit a
      // PowerShell 7-only path (which hides Get-FileHash on some hosts).
      const env = { ...process.env };
      delete env.PSModulePath;
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'deploy_agent_dll.ps1'), '-GameDirectory', game], { windowsHide: true, env });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject); child.once('close', code => resolve({ code, output }));
    });
    if (scenario === 'valid') {
      assert.equal(result.code, 0, result.output);
      const receipt = JSON.parse(result.output.replace(/^\uFEFF/u, ''));
      assert.equal(receipt.sha256.toLowerCase(), hash('new'));
      const manifest = JSON.parse((await readFile(receipt.manifest, 'utf8')).replace(/^\uFEFF/u, ''));
      assert.equal(await readFile(manifest.backup, 'utf8'), 'previous');
      assert.equal(await readFile(join(game, 'ddaccess.dll'), 'utf8'), 'new');
    } else {
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /Rebuild before deployment/u);
      assert.equal(await readFile(join(game, 'ddaccess.dll'), 'utf8'), 'previous');
    }
  });
}
