param(
    [string]$GameDirectory = $env:DD1_GAME_DIR
)

$ErrorActionPreference = 'Stop'
if (-not $GameDirectory) {
    throw 'Pass -GameDirectory or set DD1_GAME_DIR to the DarkestDungeon\_windows\win64 directory.'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDll = Join-Path $projectRoot 'references\Blindest-Dungeon\Source\Mod\build\ddaccess.dll'
$targetDll = Join-Path (Resolve-Path -LiteralPath $GameDirectory).Path 'ddaccess.dll'
if (Get-Process -Name 'Darkest*' -ErrorAction SilentlyContinue) {
    throw 'Close Darkest Dungeon and its launcher before replacing ddaccess.dll.'
}
if (!(Test-Path -LiteralPath $sourceDll) -or !(Test-Path -LiteralPath $targetDll)) {
    throw 'Both the compiled DLL and the existing game DLL must exist.'
}

$backupDirectory = Join-Path $projectRoot ('backups\pre-id-abstraction-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
$previousDll = Join-Path $backupDirectory 'ddaccess.dll'
$oldHash = (Get-FileHash -LiteralPath $targetDll -Algorithm SHA256).Hash
$newHash = (Get-FileHash -LiteralPath $sourceDll -Algorithm SHA256).Hash
Copy-Item -LiteralPath $targetDll -Destination $previousDll
if ((Get-FileHash -LiteralPath $previousDll -Algorithm SHA256).Hash -ne $oldHash) {
    throw 'DLL backup verification failed; no deployment performed.'
}

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
}
$manifestPath = Join-Path $backupDirectory 'deployment.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
[ordered]@{ deployed = $true; bytes = $manifest.bytes; sha256 = $newHash; manifest = $manifestPath } | ConvertTo-Json
