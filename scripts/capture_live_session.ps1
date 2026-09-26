[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^profile_[0-9]+$')]
    [string]$Profile,

    [string]$SteamRoot = 'C:\Program Files (x86)\Steam',
    [string]$GameDirectory = $env:DD1_GAME_ROOT,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '..\fixtures\captures'),

    [ValidateRange(100, 5000)]
    [int]$PollMilliseconds = 250,

    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 900
)

$ErrorActionPreference = 'Stop'
if (-not $GameDirectory) {
    throw 'Pass -GameDirectory or set DD1_GAME_ROOT to the DarkestDungeon installation directory.'
}
$appId = '262060'
$userdataRoot = Join-Path $SteamRoot 'userdata'
$gameWin64 = Join-Path $GameDirectory '_windows\win64'
$debugLog = Join-Path $gameWin64 'ddaccess-debug.log'

if (-not (Test-Path -LiteralPath $userdataRoot)) {
    throw "Steam userdata directory not found: $userdataRoot"
}

$profileMatches = @()
foreach ($account in Get-ChildItem -LiteralPath $userdataRoot -Directory) {
    $candidate = Join-Path $account.FullName "$appId\remote\$Profile"
    if (Test-Path -LiteralPath $candidate) { $profileMatches += $candidate }
}
if ($profileMatches.Count -eq 0) { throw "Save profile not found: $Profile" }
if ($profileMatches.Count -gt 1) {
    throw "More than one Steam account contains $Profile; an explicit source selector is required."
}

$source = $profileMatches[0]
$sessionName = '{0}-{1}-live' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Profile
$sessionDirectory = Join-Path $OutputRoot $sessionName
$snapshotsDirectory = Join-Path $sessionDirectory 'save-snapshots'
$eventsPath = Join-Path $sessionDirectory 'events.jsonl'
$manifestPath = Join-Path $sessionDirectory 'manifest.json'
$capturedLogPath = Join-Path $sessionDirectory 'ddaccess-debug.log'

New-Item -ItemType Directory -Path $snapshotsDirectory -Force | Out-Null

function Get-ProfileState {
    param([Parameter(Mandatory)][string]$Path)

    $state = @{}
    # DD1 briefly creates replacement files such as `persist.map.json.stmp`.
    # They can disappear between enumeration and copying, so capture only the
    # committed persist JSON files that the game exposes as stable state.
    foreach ($file in Get-ChildItem -LiteralPath $Path -File -Filter 'persist.*.json') {
        $state[$file.Name] = [pscustomobject]@{
            name = $file.Name
            length = $file.Length
            lastWriteTimeUtcTicks = $file.LastWriteTimeUtc.Ticks
            fullName = $file.FullName
        }
    }
    return $state
}

function Write-Event {
    param(
        [Parameter(Mandatory)][string]$Kind,
        [Parameter(Mandatory)][hashtable]$Data
    )

    $record = [ordered]@{
        observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        kind = $Kind
    }
    foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
    $record | ConvertTo-Json -Compress -Depth 6 | Add-Content -LiteralPath $eventsPath -Encoding utf8NoBOM
}

function Copy-StableFile {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath
    )

    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try {
            $before = Get-Item -LiteralPath $SourcePath
            Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
            $after = Get-Item -LiteralPath $SourcePath
            if ($before.Length -ne $after.Length -or
                $before.LastWriteTimeUtc.Ticks -ne $after.LastWriteTimeUtc.Ticks) {
                Start-Sleep -Milliseconds 40
                continue
            }

            $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
            $targetHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash
            if ($sourceHash -eq $targetHash) {
                return [pscustomobject]@{
                    length = $after.Length
                    lastWriteTimeUtc = $after.LastWriteTimeUtc.ToString('o')
                    sha256 = $targetHash
                }
            }
        } catch {
            if ($attempt -eq 8) { throw }
        }
        Start-Sleep -Milliseconds 40
    }
    throw "Could not obtain a stable copy of: $SourcePath"
}

$manifest = [ordered]@{
    schemaVersion = 1
    startedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    profile = $Profile
    source = "Steam/userdata/<account>/$appId/remote/$Profile"
    gameLog = 'DarkestDungeon/_windows/win64/ddaccess-debug.log'
    pollMilliseconds = $PollMilliseconds
    requestedDurationSeconds = $DurationSeconds
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

$sequence = 0
$previousState = @{}
$previousLogLength = $null
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)

Write-Host "Capturing $Profile for up to $DurationSeconds seconds."
Write-Host "Session: $sessionDirectory"
Write-Host 'Press Ctrl+C after the manual test is complete.'

try {
    while ([DateTime]::UtcNow -lt $deadline) {
        $currentState = Get-ProfileState -Path $source
        $changedNames = @()

        foreach ($name in $currentState.Keys) {
            if (-not $previousState.ContainsKey($name) -or
                $currentState[$name].length -ne $previousState[$name].length -or
                $currentState[$name].lastWriteTimeUtcTicks -ne $previousState[$name].lastWriteTimeUtcTicks) {
                $changedNames += $name
            }
        }

        foreach ($name in $previousState.Keys) {
            if (-not $currentState.ContainsKey($name)) {
                Write-Event -Kind 'save-file-deleted' -Data @{ file = $name }
            }
        }

        if ($changedNames.Count -gt 0) {
            $sequence++
            $snapshotDirectory = Join-Path $snapshotsDirectory ('{0:D6}' -f $sequence)
            New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null

            foreach ($name in ($changedNames | Sort-Object)) {
                $target = Join-Path $snapshotDirectory $name
                try {
                    $copy = Copy-StableFile -SourcePath $currentState[$name].fullName -DestinationPath $target
                    Write-Event -Kind 'save-file-captured' -Data @{
                        sequence = $sequence
                        file = $name
                        snapshot = "save-snapshots/{0:D6}/$name" -f $sequence
                        length = $copy.length
                        lastWriteTimeUtc = $copy.lastWriteTimeUtc
                        sha256 = $copy.sha256
                    }
                } catch {
                    Write-Event -Kind 'save-file-capture-error' -Data @{
                        sequence = $sequence
                        file = $name
                        message = $_.Exception.Message
                    }
                }
            }
        }
        $previousState = $currentState

        if (Test-Path -LiteralPath $debugLog) {
            $logItem = Get-Item -LiteralPath $debugLog
            if ($null -eq $previousLogLength -or $logItem.Length -ne $previousLogLength) {
                Write-Event -Kind 'debug-log-size' -Data @{
                    length = $logItem.Length
                    lastWriteTimeUtc = $logItem.LastWriteTimeUtc.ToString('o')
                }
                $previousLogLength = $logItem.Length
            }
        }

        Start-Sleep -Milliseconds $PollMilliseconds
    }
} finally {
    if (Test-Path -LiteralPath $debugLog) {
        try {
            Copy-Item -LiteralPath $debugLog -Destination $capturedLogPath -Force
        } catch {
            Write-Event -Kind 'debug-log-copy-error' -Data @{ message = $_.Exception.Message }
        }
    }

    $manifest.completedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    $manifest.snapshotCount = $sequence
    $manifest.debugLogCaptured = (Test-Path -LiteralPath $capturedLogPath)
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

    Write-Host "Capture stopped. Snapshots: $sequence"
    Write-Host "Manifest: $manifestPath"
}
