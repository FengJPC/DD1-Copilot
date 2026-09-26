[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^profile_[0-9]+$')]
    [string]$Profile,

    [string]$SteamRoot = 'C:\Program Files (x86)\Steam',
    [string]$OutputRoot = "$env:TEMP\DD1AgentBridge\captures"
)

$ErrorActionPreference = 'Stop'
$appId = '262060'
$userdataRoot = Join-Path $SteamRoot 'userdata'

if (-not (Test-Path -LiteralPath $userdataRoot)) {
    throw "Steam userdata directory not found: $userdataRoot"
}

$matches = @()
foreach ($account in Get-ChildItem -LiteralPath $userdataRoot -Directory) {
    $candidate = Join-Path $account.FullName "$appId\remote\$Profile"
    if (Test-Path -LiteralPath $candidate) { $matches += $candidate }
}

if ($matches.Count -eq 0) { throw "Save profile not found: $Profile" }
if ($matches.Count -gt 1) {
    throw "More than one Steam account contains $Profile. Add an explicit source-path option before using this script."
}

$source = $matches[0]

# Avoid copying a file while the game is replacing it. Two equal metadata
# samples are a cheap stability gate; hash verification below is the final gate.
$stable = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
    $before = @(Get-ChildItem -LiteralPath $source -File | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{ Name = $_.Name; Length = $_.Length; LastWriteTimeUtc = $_.LastWriteTimeUtc.Ticks }
    })
    Start-Sleep -Milliseconds 150
    $after = @(Get-ChildItem -LiteralPath $source -File | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{ Name = $_.Name; Length = $_.Length; LastWriteTimeUtc = $_.LastWriteTimeUtc.Ticks }
    })
    if (($before | ConvertTo-Json -Compress) -eq ($after | ConvertTo-Json -Compress)) {
        $stable = $true
        break
    }
}
if (-not $stable) { throw "Save profile remained active during all stability checks: $Profile" }

$captureName = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Profile
$destination = Join-Path $OutputRoot $captureName
$rawDirectory = Join-Path $destination 'raw'
New-Item -ItemType Directory -Path $rawDirectory -Force | Out-Null

$records = @()
foreach ($file in Get-ChildItem -LiteralPath $source -File | Sort-Object Name) {
    $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $target = Join-Path $rawDirectory $file.Name
    Copy-Item -LiteralPath $file.FullName -Destination $target
    $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) {
        throw "Snapshot hash mismatch: $($file.Name)"
    }
    $records += [pscustomobject]@{
        name             = $file.Name
        length           = $file.Length
        lastWriteTimeUtc = $file.LastWriteTimeUtc.ToString('o')
        sha256           = $targetHash
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    appId         = $appId
    profile       = $Profile
    source        = "Steam/userdata/<account>/$appId/remote/$Profile"
    fileCount     = $records.Count
    files         = $records
}
$manifestPath = Join-Path $destination 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

[pscustomobject]@{
    CaptureDirectory = $destination
    Manifest         = $manifestPath
    FileCount        = $records.Count
    TotalBytes       = ($records | Measure-Object length -Sum).Sum
    Verified         = $true
}
