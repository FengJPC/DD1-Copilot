[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) {
    $OutputPath = Join-Path $projectRoot 'docs\experiments\001-environment.md'
}

$appId = '262060'
$tick = [char]96

function Get-RegistrySteamRoot {
    $candidates = @(
        @{ Path = 'HKCU:\Software\Valve\Steam'; Property = 'SteamPath' },
        @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'; Property = 'InstallPath' },
        @{ Path = 'HKLM:\SOFTWARE\Valve\Steam'; Property = 'InstallPath' }
    )

    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
        $item = Get-ItemProperty -LiteralPath $candidate.Path
        $value = $item.($candidate.Property)
        if ($value -and (Test-Path -LiteralPath $value)) {
            return (Resolve-Path -LiteralPath $value).Path
        }
    }
    return $null
}

function Get-AcfValue {
    param(
        [Parameter(Mandatory)] [string]$Text,
        [Parameter(Mandatory)] [string]$Name
    )
    $pattern = '(?m)^\s*"' + [regex]::Escape($Name) + '"\s+"([^"]*)"\s*$'
    $match = [regex]::Match($Text, $pattern)
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

function Get-PeInfo {
    param([Parameter(Mandatory)] [string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 512) { throw "PE file is too small: $Path" }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($peOffset -lt 0 -or ($peOffset + 84) -gt $bytes.Length) {
        throw "Invalid PE header offset: $Path"
    }

    [pscustomobject]@{
        Path        = $Path
        Length      = $bytes.Length
        Machine     = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
        Timestamp   = [BitConverter]::ToUInt32($bytes, $peOffset + 8)
        Magic       = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
        SizeOfImage = [BitConverter]::ToUInt32($bytes, $peOffset + 80)
        SHA256      = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }
}

function Get-Hex32 {
    param([uint32]$Value)
    return ('0x{0:X8}' -f $Value)
}

function Get-Hex {
    param([uint32]$Value)
    return ('0x{0:X}' -f $Value)
}

function Get-SourceConstant {
    param(
        [Parameter(Mandatory)] [string]$Text,
        [Parameter(Mandatory)] [string]$Name
    )
    $match = [regex]::Match($Text, [regex]::Escape($Name) + '\s*=\s*0x([0-9a-fA-F]+)')
    if (-not $match.Success) { return $null }
    return [Convert]::ToUInt32($match.Groups[1].Value, 16)
}

$steamRoot = Get-RegistrySteamRoot
$libraryRoots = [System.Collections.Generic.List[string]]::new()
if ($steamRoot) { $libraryRoots.Add($steamRoot) }

if ($steamRoot) {
    $libraryVdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $libraryVdf) {
        $libraryText = Get-Content -LiteralPath $libraryVdf -Raw
        foreach ($match in [regex]::Matches($libraryText, '"path"\s+"([^"]+)"')) {
            $path = $match.Groups[1].Value -replace '\\\\', '\'
            if ((Test-Path -LiteralPath $path) -and -not $libraryRoots.Contains($path)) {
                $libraryRoots.Add($path)
            }
        }
    }
}

$manifestPath = $null
foreach ($root in $libraryRoots) {
    $candidate = Join-Path $root "steamapps\appmanifest_$appId.acf"
    if (Test-Path -LiteralPath $candidate) {
        $manifestPath = $candidate
        break
    }
}

$manifest = $null
$installDir = $null
$buildId = $null
$targetBuildId = $null
$bytesToDownload = $null
$stateFlags = $null
$gamePath = $null
if ($manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw
    $installDir = Get-AcfValue -Text $manifest -Name 'installdir'
    $buildId = Get-AcfValue -Text $manifest -Name 'buildid'
    $targetBuildId = Get-AcfValue -Text $manifest -Name 'TargetBuildID'
    $bytesToDownload = Get-AcfValue -Text $manifest -Name 'BytesToDownload'
    $stateFlags = Get-AcfValue -Text $manifest -Name 'StateFlags'
    $libraryRoot = Split-Path -Parent (Split-Path -Parent $manifestPath)
    if ($installDir) { $gamePath = Join-Path $libraryRoot "steamapps\common\$installDir" }
}

$blindestRoot = Join-Path $projectRoot 'references\Blindest-Dungeon'
$offsetsPath = Join-Path $blindestRoot 'Source\Mod\src\game\offsets.h'
$expected = @{}
if (Test-Path -LiteralPath $offsetsPath) {
    $offsetText = Get-Content -LiteralPath $offsetsPath -Raw
    $expected.SteamTimestamp = Get-SourceConstant -Text $offsetText -Name 'GAME_PE_TIMESTAMP'
    $expected.SteamImage = Get-SourceConstant -Text $offsetText -Name 'GAME_PE_SIZEOFIMAGE'
    $expected.DrmTimestamp = Get-SourceConstant -Text $offsetText -Name 'GAME_PE_TIMESTAMP_DRMFREE'
    $expected.DrmImage = Get-SourceConstant -Text $offsetText -Name 'GAME_PE_SIZEOFIMAGE_DRMFREE'
}

$binarySpecs = @(
    @{ Name = 'Steam win32'; Relative = '_windows\win32\Darkest.exe'; ExpectedKind = 'unsupported' },
    @{ Name = 'Steam win64'; Relative = '_windows\win64\Darkest.exe'; ExpectedKind = 'steam' },
    @{ Name = 'DRM-free win32'; Relative = '_windowsnosteam\win32\Darkest.exe'; ExpectedKind = 'unsupported' },
    @{ Name = 'DRM-free win64'; Relative = '_windowsnosteam\win64\Darkest.exe'; ExpectedKind = 'drmfree' }
)

$binaries = @()
if ($gamePath -and (Test-Path -LiteralPath $gamePath)) {
    foreach ($spec in $binarySpecs) {
        $path = Join-Path $gamePath $spec.Relative
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $pe = Get-PeInfo -Path $path
        $compatible = $false
        if ($spec.ExpectedKind -eq 'steam' -and $expected.SteamTimestamp) {
            $compatible = ($pe.Timestamp -eq $expected.SteamTimestamp -and $pe.SizeOfImage -eq $expected.SteamImage)
        } elseif ($spec.ExpectedKind -eq 'drmfree' -and $expected.DrmTimestamp) {
            $compatible = ($pe.Timestamp -eq $expected.DrmTimestamp -and $pe.SizeOfImage -eq $expected.DrmImage)
        }
        $binaries += [pscustomobject]@{
            Name       = $spec.Name
            Relative   = $spec.Relative
            Info       = $pe
            Compatible = $compatible
            Kind       = $spec.ExpectedKind
        }
    }
}

$profiles = @()
$accountCount = 0
if ($steamRoot) {
    $userdataRoot = Join-Path $steamRoot 'userdata'
    if (Test-Path -LiteralPath $userdataRoot) {
        foreach ($account in Get-ChildItem -LiteralPath $userdataRoot -Directory) {
            $appRoot = Join-Path $account.FullName $appId
            $remote = Join-Path $appRoot 'remote'
            if (-not (Test-Path -LiteralPath $remote)) { continue }
            $accountCount++
            foreach ($profile in Get-ChildItem -LiteralPath $remote -Directory) {
                $files = @(Get-ChildItem -LiteralPath $profile.FullName -File -ErrorAction SilentlyContinue)
                $latest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                $profiles += [pscustomobject]@{
                    AccountLabel = "account-$accountCount"
                    Profile      = $profile.Name
                    FileCount    = $files.Count
                    TotalBytes   = if ($files.Count) { ($files | Measure-Object Length -Sum).Sum } else { 0 }
                    LatestWrite  = if ($latest) { $latest.LastWriteTime } else { $null }
                    HasRaid      = Test-Path -LiteralPath (Join-Path $profile.FullName 'persist.raid.json')
                }
            }
        }
    }
}

$workshopCount = 0
if ($manifestPath) {
    $libraryRoot = Split-Path -Parent (Split-Path -Parent $manifestPath)
    $workshopRoot = Join-Path $libraryRoot "steamapps\workshop\content\$appId"
    if (Test-Path -LiteralPath $workshopRoot) {
        $workshopCount = @(Get-ChildItem -LiteralPath $workshopRoot -Directory).Count
    }
}

$tools = @('git', 'node', 'npm', 'python', 'java', 'javac', 'cl', 'cmake') | ForEach-Object {
    $command = Get-Command $_ -ErrorAction SilentlyContinue | Select-Object -First 1
    $resolvedPath = if ($command) { $command.Source } else { '' }
    [pscustomobject]@{
        Name  = $_
        Found = [bool]$resolvedPath
        Path  = $resolvedPath
    }
}

$decoderJar = Join-Path $projectRoot 'references\darkest-dungeon-mcp\tools\DDSaveEditor.jar'
$decoderJarHash = if (Test-Path -LiteralPath $decoderJar) {
    (Get-FileHash -LiteralPath $decoderJar -Algorithm SHA256).Hash
} else {
    $null
}

$nonStandardFiles = @()
if ($gamePath) {
    foreach ($name in @('cream_api.ini', '暗黑地牢1dlc补丁.exe', '暗黑地牢1dlc补丁.zip')) {
        $path = Join-Path $gamePath $name
        if (Test-Path -LiteralPath $path) { $nonStandardFiles += $name }
    }
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# M0 环境基线')
$lines.Add('')
$lines.Add('> 由 `scripts/probe_environment.ps1` 只读生成。报告隐藏 Steam 账户数字 ID，不启动游戏、不执行 DLL、不修改存档。')
$lines.Add('')
$lines.Add("- 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add("- Steam 根目录：$tick$steamRoot$tick")
$lines.Add("- DD1 App ID：$tick$appId$tick")
$lines.Add("- DD1 安装目录：$tick$gamePath$tick")
$lines.Add("- 已安装 build ID：$tick$buildId$tick")
$lines.Add("- 目标 build ID：$tick$targetBuildId$tick")
$lines.Add("- Steam StateFlags：$tick$stateFlags$tick")
$lines.Add("- 待下载字节：$tick$bytesToDownload$tick")
$lines.Add("- Workshop 内容目录数：$workshopCount")
$lines.Add('')

$lines.Add('## Blindest 参考版本')
$lines.Add('')
if (Test-Path -LiteralPath (Join-Path $blindestRoot '.git')) {
    $commit = (& git -C $blindestRoot rev-parse HEAD).Trim()
    $subject = (& git -C $blindestRoot log -1 --format='%s').Trim()
    $lines.Add("- 本地提交：$tick$commit$tick")
    $lines.Add("- 最新提交说明：$subject")
}
if ($expected.SteamTimestamp) {
    $lines.Add("- 预期 Steam win64 指纹：Timestamp $tick$(Get-Hex32 $expected.SteamTimestamp)$tick，SizeOfImage $tick$(Get-Hex $expected.SteamImage)$tick")
    $lines.Add("- 预期 DRM-free win64 指纹：Timestamp $tick$(Get-Hex32 $expected.DrmTimestamp)$tick，SizeOfImage $tick$(Get-Hex $expected.DrmImage)$tick")
}
$lines.Add('')

$lines.Add('## 游戏二进制')
$lines.Add('')
$lines.Add('| 版本 | 路径 | PE Timestamp | SizeOfImage | SHA256 | 与 Blindest 匹配 |')
$lines.Add('|---|---|---:|---:|---|---|')
foreach ($binary in $binaries) {
    $matchText = if ($binary.Kind -eq 'unsupported') { '未纳入 v0.10 指纹表' } elseif ($binary.Compatible) { '是' } else { '否' }
    $shortHash = $binary.Info.SHA256.Substring(0, 16) + '…'
    $lines.Add("| $($binary.Name) | $tick$($binary.Relative)$tick | $tick$(Get-Hex32 $binary.Info.Timestamp)$tick | $tick$(Get-Hex $binary.Info.SizeOfImage)$tick | $tick$shortHash$tick | $matchText |")
}
$lines.Add('')

$lines.Add('## 存档档位')
$lines.Add('')
$lines.Add('| 账户标签 | 档位 | 文件数 | 总大小 | 最新修改 | 含 `persist.raid.json` |')
$lines.Add('|---|---|---:|---:|---|---|')
foreach ($profile in $profiles) {
    $latest = if ($profile.LatestWrite) { $profile.LatestWrite.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
    $lines.Add("| $($profile.AccountLabel) | $tick$($profile.Profile)$tick | $($profile.FileCount) | $($profile.TotalBytes) | $latest | $($profile.HasRaid) |")
}
$lines.Add('')

$lines.Add('## 本机构建工具')
$lines.Add('')

$lines.Add('## 存档解码器')
$lines.Add('')
if ($decoderJarHash) {
    $lines.Add("- DDSaveEditor JAR：$tick$decoderJar$tick")
    $lines.Add("- SHA256：$tick$decoderJarHash$tick")
    $lines.Add('- 当前 Java 8 对含中文的绝对 JAR 参数存在兼容问题；运行时通过 `scripts/prepare_decoder.ps1` 复制到纯 ASCII 临时路径。')
} else {
    $lines.Add('- 尚未准备 DDSaveEditor JAR。')
}
$lines.Add('')
$lines.Add('| 工具 | 已找到 | 路径 |')
$lines.Add('|---|---|---|')
foreach ($tool in $tools) {
    $pathText = if ($tool.Path) { "$tick$($tool.Path)$tick" } else { '' }
    $lines.Add("| $($tool.Name) | $($tool.Found) | $pathText |")
}
$lines.Add('')

$lines.Add('## 自动结论')
$lines.Add('')
$compatible64 = @($binaries | Where-Object { $_.Kind -in @('steam', 'drmfree') -and $_.Compatible })
if ($compatible64.Count -eq 0) {
    $lines.Add('- **兼容性门槛未通过：当前检测到的 win64 游戏二进制与 Blindest v0.10 源码中的 PE 指纹不匹配。不要在确认游戏更新与版本对应关系以前注入 DLL。**')
} else {
    $lines.Add('- 至少有一个 win64 游戏二进制与 Blindest v0.10 的 PE 指纹完全匹配。')
}
if ($targetBuildId -and $buildId -and $targetBuildId -ne $buildId) {
    $lines.Add("- Steam 清单显示当前 build $tick$buildId$tick，目标 build $tick$targetBuildId$tick；存在尚未完成的游戏更新。")
}
if (-not ($tools | Where-Object Name -eq 'java').Found) {
    $lines.Add('- 当前 PATH 中未找到 Java；基于 Java 的 DarkestDungeonSaveEditor 尚不能直接运行。')
} elseif (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $lines.Add('- 已找到 Mathematica 自带的 Java 8，可显式指定其路径运行 DDSaveEditor；它没有加入 PATH。')
}
if (($tools | Where-Object Name -eq 'cl').Found) {
    $lines.Add('- 已找到 MSVC `cl.exe`，具备尝试编译 Blindest C++ 源码的基础条件。')
}
if ($workshopCount -gt 0) {
    $lines.Add("- 检测到 $workshopCount 个 Workshop 内容目录；仅凭目录不能判断当前存档启用了哪些 Mod，需要后续从存档或游戏配置确认。")
}
if ($nonStandardFiles.Count -gt 0) {
    $joined = ($nonStandardFiles | ForEach-Object { "$tick$_$tick" }) -join '、'
    $lines.Add("- 游戏根目录检测到非标准附加文件：$joined。运行时兼容性必须以当前实际环境测试，不假设为纯净 Steam 安装。")
}
$lines.Add('')
$lines.Add('## 下一步')
$lines.Add('')
if ($targetBuildId -and $buildId -and $targetBuildId -ne $buildId) {
    $lines.Add('1. 先让 Steam 完成 DD1 更新，再重新运行本脚本。')
    $lines.Add('2. 更新后重新核对 PE Timestamp 和 SizeOfImage。')
} elseif ($compatible64.Count -eq 0) {
    $lines.Add('1. 当前游戏已经是 Steam 清单中的目标 build，但 PE 指纹仍不匹配；先确认 Blindest 支持的具体版本。')
} else {
    $lines.Add('1. 当前 Steam win64 构建与 Blindest v0.10 指纹匹配，可以进入原版运行测试。')
}
$lines.Add('2. 选择独立测试档，并在采集前制作只读快照。')
$lines.Add('3. 解决 DDSaveEditor 的 Java 运行环境或采用可嵌入解析器。')
$lines.Add('4. 开启 Blindest 调试日志，手动完成一场普通战斗并采集关键节点。')

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
[IO.File]::WriteAllLines($OutputPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Output $OutputPath
