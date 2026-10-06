param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$package = Join-Path $repository 'build\dd1-copilot'
if (-not (Test-Path -LiteralPath (Join-Path $package '.codex-plugin\plugin.json'))) {
    throw 'Run npm run plugin:package before installing DD1 Copilot.'
}
& node (Join-Path $package 'scripts\server.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'DD1 plugin startup check failed. Run scripts/configure-plugin.ps1 first.' }
if ($CheckOnly) { return }
& codex plugin marketplace add $repository --json
if ($LASTEXITCODE -ne 0) { throw 'Could not register DD1 local marketplace.' }
& codex plugin add 'dd1-copilot@dd1-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Could not install DD1 Copilot.' }
& codex plugin list --marketplace dd1-local --json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify installed DD1 Copilot.' }
Write-Host 'DD1 Copilot installed. Refresh/restart Codex; use a new chat if tools have not refreshed.'
