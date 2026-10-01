param(
    [string]$GameDirectory = $env:DD1_GAME_DIR,
    [string]$PipeName = '\\.\pipe\dd1-agent-bridge',
    [string]$ClientSid = '',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'resolve_game_directory.ps1')
$GameDirectory = Resolve-Dd1GameDirectory -GameDirectory $GameDirectory

$launcher = Join-Path $GameDirectory 'DarkestAccess.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Blindest launcher not found: $launcher"
}
$game = Join-Path $GameDirectory 'Darkest.exe'
if (-not (Test-Path -LiteralPath $game)) {
    throw "Game executable not found: $game"
}

if ($CheckOnly) {
    Write-Host "[+] Game directory: $GameDirectory"
    Write-Host "[+] Launcher: $launcher"
    Write-Host '[+] Configuration checked. No process was started.'
    return
}

if (Get-Process -Name 'Darkest*' -ErrorAction SilentlyContinue) {
    throw 'Darkest Dungeon is already running.'
}

# Keep the command bridge opt-in: only this launcher process and its children
# inherit the pipe name. No persistent user or machine environment is changed.
$previousPipe = $env:DD1_AGENT_PIPE
$previousClientSid = $env:DD1_AGENT_CLIENT_SID
$previousSpeech = $env:DD1_AGENT_SPEECH
try {
    if (-not $ClientSid) {
        try {
            $account = [System.Security.Principal.NTAccount]::new(
                $env:COMPUTERNAME, 'CodexSandboxUsers')
            $ClientSid = $account.Translate(
                [System.Security.Principal.SecurityIdentifier]).Value
        } catch {
            Write-Warning 'CodexSandboxUsers SID was not found; only the game user will be allowed.'
        }
    }
    $env:DD1_AGENT_PIPE = $PipeName
    $env:DD1_AGENT_CLIENT_SID = $ClientSid
    $env:DD1_AGENT_SPEECH = '0'
    # DarkestAccess normally asks an already-running Steam process to launch the
    # game. That loses this process-scoped environment variable. Start the game
    # directly so it inherits the pipe, then let DarkestAccess inject the DLL.
    Start-Process -FilePath $game -WorkingDirectory $GameDirectory
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $gameProcess = Get-Process -Name 'Darkest' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    } while (-not $gameProcess -and (Get-Date) -lt $deadline)
    if (-not $gameProcess) {
        throw 'Darkest Dungeon did not start within 20 seconds.'
    }
    Start-Process -FilePath $launcher -WorkingDirectory $GameDirectory
} finally {
    $env:DD1_AGENT_PIPE = $previousPipe
    $env:DD1_AGENT_CLIENT_SID = $previousClientSid
    $env:DD1_AGENT_SPEECH = $previousSpeech
}

Write-Host "[+] Started DarkestAccess with DD1_AGENT_PIPE=$PipeName"
Write-Host '[+] DarkestAccess speech is disabled for this session.'
if ($ClientSid) { Write-Host "[+] Allowed command client SID: $ClientSid" }
