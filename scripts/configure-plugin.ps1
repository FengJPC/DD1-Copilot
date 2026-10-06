param(
    [string]$GameDirectory = $env:DD1_GAME_DIR,
    [string]$SaveDirectory,
    [string]$CampaignId,
    [string]$ConfigurationPath,
    [string]$PipeName,
    [switch]$FromProject,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve_game_directory.ps1')
$gamePath = Resolve-Dd1GameDirectory -GameDirectory $GameDirectory
$arguments = @((Join-Path $PSScriptRoot 'configure-plugin.mjs'), '--game-directory', $gamePath)
if ($FromProject) { $arguments += '--from-project' }
if ($SaveDirectory) { $arguments += @('--save-directory', $SaveDirectory) }
if ($CampaignId) { $arguments += @('--campaign-id', $CampaignId) }
if ($ConfigurationPath) { $arguments += @('--config', $ConfigurationPath) }
if ($PipeName) { $arguments += @('--pipe', $PipeName) }
if (-not $CheckOnly) { $arguments += '--apply' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'DD1 plugin configuration failed.' }
