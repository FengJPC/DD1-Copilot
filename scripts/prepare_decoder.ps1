[CmdletBinding()]
param(
    [string]$SourceJar,
    [string]$JavaExecutable = $env:DD1_JAVA_EXECUTABLE
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SourceJar) {
    $SourceJar = Join-Path $projectRoot 'references\darkest-dungeon-mcp\tools\DDSaveEditor.jar'
}
if (-not $JavaExecutable) {
    $javaCommand = Get-Command java -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($javaCommand) { $JavaExecutable = $javaCommand.Source }
}

if (-not (Test-Path -LiteralPath $SourceJar)) {
    throw "DDSaveEditor.jar not found: $SourceJar"
}
if (-not $JavaExecutable -or -not (Test-Path -LiteralPath $JavaExecutable)) {
    throw "Java executable not found: $JavaExecutable"
}

# The bundled Java 8 runtime cannot reliably open an absolute JAR argument whose
# path contains Chinese characters. Keep the project in place and use an ASCII
# runtime copy under the user's temporary directory.
$runtimeDirectory = Join-Path $env:TEMP 'DD1AgentBridge\tools'
$runtimeJar = Join-Path $runtimeDirectory 'DDSaveEditor.jar'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$sourceHash = (Get-FileHash -LiteralPath $SourceJar -Algorithm SHA256).Hash
$needsCopy = -not (Test-Path -LiteralPath $runtimeJar)
if (-not $needsCopy) {
    $runtimeHash = (Get-FileHash -LiteralPath $runtimeJar -Algorithm SHA256).Hash
    $needsCopy = $runtimeHash -ne $sourceHash
}
if ($needsCopy) {
    Copy-Item -LiteralPath $SourceJar -Destination $runtimeJar -Force
}

$versionOutput = & $JavaExecutable -version 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Java runtime validation failed.' }

[pscustomobject]@{
    JavaExecutable = $JavaExecutable
    DecoderJar     = $runtimeJar
    SHA256         = (Get-FileHash -LiteralPath $runtimeJar -Algorithm SHA256).Hash
    JavaVersion    = ($versionOutput | Select-Object -First 1).ToString()
}
