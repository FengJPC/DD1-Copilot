function Resolve-Dd1GameDirectory {
    [CmdletBinding()]
    param(
        [string]$GameDirectory = $env:DD1_GAME_DIR,
        [string]$ConfigurationPath = (Join-Path $PSScriptRoot '..\launcher.local.json'),
        [string[]]$SteamDirectories
    )

    # Explicit configuration takes precedence; an invalid override must not
    # silently launch another installation.
    if (-not $GameDirectory -and (Test-Path -LiteralPath $ConfigurationPath)) {
        $configuration = Get-Content -LiteralPath $ConfigurationPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
        $GameDirectory = $configuration.gameDirectory
    }
    if ($GameDirectory) {
        $candidates = @($GameDirectory, (Join-Path $GameDirectory '_windows\win64'))
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath (Join-Path $candidate 'Darkest.exe')) {
                return (Resolve-Path -LiteralPath $candidate).ProviderPath
            }
        }
        throw "Darkest.exe not found under the configured game directory: $GameDirectory"
    }

    if (-not $PSBoundParameters.ContainsKey('SteamDirectories')) {
        $SteamDirectories = @()
        foreach ($registryPath in @('HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam')) {
            $steam = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
            if ($steam.SteamPath) { $SteamDirectories += $steam.SteamPath }
            if ($steam.InstallPath) { $SteamDirectories += $steam.InstallPath }
        }
        if (${env:ProgramFiles(x86)}) {
            $SteamDirectories += Join-Path ${env:ProgramFiles(x86)} 'Steam'
        }
        if ($env:ProgramFiles) {
            $SteamDirectories += Join-Path $env:ProgramFiles 'Steam'
        }
    }

    $libraryDirectories = @($SteamDirectories)
    foreach ($steamDirectory in ($SteamDirectories | Select-Object -Unique)) {
        $libraryFile = Join-Path $steamDirectory 'steamapps\libraryfolders.vdf'
        if (-not (Test-Path -LiteralPath $libraryFile)) { continue }
        $libraryText = Get-Content -LiteralPath $libraryFile -Raw -Encoding UTF8
        foreach ($match in [regex]::Matches($libraryText, '"path"\s+"([^"]+)"')) {
            $libraryDirectories += $match.Groups[1].Value.Replace('\\', '\')
        }
    }

    $installations = @()
    foreach ($libraryDirectory in ($libraryDirectories | Select-Object -Unique)) {
        $candidate = Join-Path $libraryDirectory 'steamapps\common\DarkestDungeon\_windows\win64'
        if (Test-Path -LiteralPath (Join-Path $candidate 'Darkest.exe')) {
            $installations += (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    $installations = @($installations | Select-Object -Unique)
    if ($installations.Count -eq 1) { return $installations[0] }
    if ($installations.Count -gt 1) {
        throw "Multiple DD1 installations found. Set gameDirectory in launcher.local.json or pass -GameDirectory: $($installations -join ', ')"
    }
    throw 'Game not found. Set gameDirectory in launcher.local.json, pass -GameDirectory, or set DD1_GAME_DIR to the DarkestDungeon\_windows\win64 directory.'
}
