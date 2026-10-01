import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('Windows launcher resolves local and Steam paths without a session environment', {
  skip: process.platform !== 'win32', timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-launcher-'));
  try {
    const steam = join(directory, 'Steam');
    const library = join(directory, 'library');
    const root = join(library, 'steamapps', 'common', 'DarkestDungeon');
    const win64 = join(root, '_windows', 'win64');
    await mkdir(join(steam, 'steamapps'), { recursive: true });
    await mkdir(win64, { recursive: true });
    await writeFile(join(win64, 'Darkest.exe'), 'test placeholder; never executed');
    await writeFile(join(win64, 'DarkestAccess.exe'), 'test placeholder; never executed');
    await writeFile(join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "0" { "path" "${library.replaceAll('\\', '\\\\')}" } }`);
    const config = join(directory, 'launcher.local.json');
    await writeFile(config, JSON.stringify({ gameDirectory: root }));
    const helper = resolve('scripts/resolve_game_directory.ps1');
    const starter = resolve('scripts/start_agent_game.ps1');
    const script = join(directory, 'verify.ps1');
    await writeFile(script, `param($Helper, $Starter, $Config, $Steam, $Root, $Win64, $Missing)
$ErrorActionPreference = 'Stop'
$env:DD1_GAME_DIR = ''
. $Helper
if ((Resolve-Dd1GameDirectory -ConfigurationPath $Config -SteamDirectories @()) -ne $Win64) { throw 'Local config failed' }
if ((Resolve-Dd1GameDirectory -ConfigurationPath $Missing -SteamDirectories @($Steam)) -ne $Win64) { throw 'Steam library failed' }
if ((Resolve-Dd1GameDirectory -GameDirectory $Root -ConfigurationPath $Missing) -ne $Win64) { throw 'Root normalization failed' }
$rejected = $false
try { Resolve-Dd1GameDirectory -GameDirectory $Missing -ConfigurationPath $Config } catch { $rejected = $true }
if (-not $rejected) { throw 'Invalid explicit override was ignored' }
& $Starter -GameDirectory $Win64 -CheckOnly
Write-Output 'launcher checks passed'
`);
    const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        helper, starter, config, steam, root, win64, join(directory, 'missing')],
      { encoding: 'utf8', timeout: 8_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /No process was started/);
    assert.match(result.stdout, /launcher checks passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
