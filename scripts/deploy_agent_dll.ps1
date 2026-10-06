param(
    [string]$GameDirectory = $env:DD1_GAME_DIR
)

$ErrorActionPreference = 'Stop'
if (-not $GameDirectory) {
    throw 'Pass -GameDirectory or set DD1_GAME_DIR to the DarkestDungeon\_windows\win64 directory.'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDll = Join-Path $projectRoot 'references\Blindest-Dungeon\Source\Mod\build\ddaccess.dll'
$buildManifestPath = Join-Path (Split-Path -Parent $sourceDll) 'ddaccess.build.json'
$targetDll = Join-Path (Resolve-Path -LiteralPath $GameDirectory).Path 'ddaccess.dll'
if (Get-Process -Name 'Darkest*' -ErrorAction SilentlyContinue) {
    throw 'Close Darkest Dungeon and its launcher before replacing ddaccess.dll.'
}
if (!(Test-Path -LiteralPath $sourceDll) -or !(Test-Path -LiteralPath $targetDll)) {
    throw 'Both the compiled DLL and the existing game DLL must exist.'
}
if (!(Test-Path -LiteralPath $buildManifestPath)) { throw 'Rebuild with Mod/build.ps1 -NoDeploy to create the DLL provenance manifest.' }
$buildManifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
if ($buildManifest.version -ne 1 -or !$buildManifest.nativeSources -or
    (Get-FileHash -LiteralPath $sourceDll -Algorithm SHA256).Hash -ne $buildManifest.sha256) {
    throw 'Compiled DLL does not match its build manifest. Rebuild before deployment.'
}
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'references\Blindest-Dungeon\Source\Mod\src'))
$actualSources = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.Extension -in '.cpp', '.h', '.inc' })
$manifestPaths = @($buildManifest.nativeSources | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $sourceRoot $_.path)).ToLowerInvariant() })
if ($actualSources.Count -ne $manifestPaths.Count -or @($manifestPaths | Select-Object -Unique).Count -ne $manifestPaths.Count) {
    throw 'Native source inventory differs from the compiled DLL. Rebuild before deployment.'
}
foreach ($entry in $buildManifest.nativeSources) {
    $path = [IO.Path]::GetFullPath((Join-Path $sourceRoot $entry.path))
    if (!$path.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        !(Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw 'Native source differs from the compiled DLL. Rebuild before deployment.'
    }
}

$backupDirectory = Join-Path $projectRoot ('backups\pre-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
$previousDll = Join-Path $backupDirectory 'ddaccess.dll'
$oldHash = (Get-FileHash -LiteralPath $targetDll -Algorithm SHA256).Hash
$newHash = (Get-FileHash -LiteralPath $sourceDll -Algorithm SHA256).Hash
Copy-Item -LiteralPath $targetDll -Destination $previousDll
if ((Get-FileHash -LiteralPath $previousDll -Algorithm SHA256).Hash -ne $oldHash) {
    throw 'DLL backup verification failed; no deployment performed.'
}

if ((Get-FileHash -LiteralPath $targetDll -Algorithm SHA256).Hash -ne $oldHash) { throw 'Game DLL changed after backup; deployment cancelled.' }
if ($newHash -ne $buildManifest.sha256) { throw 'Compiled DLL changed during validation; deployment cancelled.' }
try {
    Copy-Item -LiteralPath $sourceDll -Destination $targetDll -Force
    if ((Get-FileHash -LiteralPath $targetDll -Algorithm SHA256).Hash -ne $newHash) {
        throw 'Deployed DLL hash did not match the compiled DLL.'
    }
} catch {
    Copy-Item -LiteralPath $previousDll -Destination $targetDll -Force
    throw
}

$nativeSourceRoot = Join-Path $projectRoot 'references\Blindest-Dungeon\Source\Mod\src'
$sourceFiles = Get-ChildItem -LiteralPath $nativeSourceRoot -Recurse -File |
    Where-Object { $_.Extension -in '.cpp', '.h' } |
    Sort-Object FullName |
    ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($nativeSourceRoot.Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    }
$manifest = [ordered]@{
    deployedAt = (Get-Date).ToString('o')
    source = $sourceDll
    target = $targetDll
    backup = $previousDll
    previousSha256 = $oldHash
    deployedSha256 = $newHash
    bytes = (Get-Item -LiteralPath $targetDll).Length
    nativeSources = @($sourceFiles)
    buildManifest = $buildManifest
}
$manifestPath = Join-Path $backupDirectory 'deployment.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
[ordered]@{ deployed = $true; bytes = $manifest.bytes; sha256 = $newHash; manifest = $manifestPath } | ConvertTo-Json
