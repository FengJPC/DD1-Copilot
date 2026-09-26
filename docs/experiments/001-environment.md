# M0 环境基线

> 由 `scripts/probe_environment.ps1` 只读生成。报告隐藏 Steam 账户数字 ID，不启动游戏、不执行 DLL、不修改存档。

- 生成时间：2026-09-24 23:00:41 +08:00
- Steam 根目录：`C:\Program Files (x86)\Steam`
- DD1 App ID：`262060`
- DD1 安装目录：`E:\SteamLibrary\steamapps\common\DarkestDungeon`
- 已安装 build ID：`25463639`
- 目标 build ID：`25463639`
- Steam StateFlags：`4`
- 待下载字节：`23744`
- Workshop 内容目录数：13

## Blindest 参考版本

- 本地提交：`8b2d11bb48067957a7b1f48dfbe62bf76142e0f4`
- 最新提交说明：Update README.md
- 预期 Steam win64 指纹：Timestamp `0x6AB13309`，SizeOfImage `0x2FAE000`
- 预期 DRM-free win64 指纹：Timestamp `0x6AB13742`，SizeOfImage `0x2F86000`

## 游戏二进制

| 版本 | 路径 | PE Timestamp | SizeOfImage | SHA256 | 与 Blindest 匹配 |
|---|---|---:|---:|---|---|
| Steam win32 | `_windows\win32\Darkest.exe` | `0x6AB13504` | `0x2A3B000` | `4AC994D6EA0550C4…` | 未纳入 v0.10 指纹表 |
| Steam win64 | `_windows\win64\Darkest.exe` | `0x6AB13309` | `0x2FAE000` | `4D78FBFAA65B7D00…` | 是 |
| DRM-free win32 | `_windowsnosteam\win32\Darkest.exe` | `0x6AB13956` | `0x2A04000` | `9F6420A5DEAE738E…` | 未纳入 v0.10 指纹表 |
| DRM-free win64 | `_windowsnosteam\win64\Darkest.exe` | `0x6AB13742` | `0x2F86000` | `90C6D3C14C3F8984…` | 是 |

## 存档档位

| 账户标签 | 档位 | 文件数 | 总大小 | 最新修改 | 含 `persist.raid.json` |
|---|---|---:|---:|---|---|
| account-1 | `profile_0` | 16 | 614284 | 2025-10-25 00:20:25 | False |
| account-1 | `profile_1` | 7 | 28809 | 2025-10-08 23:39:24 | True |
| account-1 | `profile_9` | 7 | 86542 | 2025-10-25 00:17:32 | False |

## 本机构建工具

## 存档解码器

- DDSaveEditor JAR：`<project>\references\darkest-dungeon-mcp\tools\DDSaveEditor.jar`
- SHA256：`FD7A052F5DA21FDE991893BC3D5AE9B03DBC59A9002B206388C3396199E10B90`
- 当前 Java 8 对含中文的绝对 JAR 参数存在兼容问题；运行时通过 `scripts/prepare_decoder.ps1` 复制到纯 ASCII 临时路径。

| 工具 | 已找到 | 路径 |
|---|---|---|
| git | True | `D:\git for windows\cmd\git.exe` |
| node | True | `C:\Program Files\nodejs\node.exe` |
| npm | True | `C:\Program Files\nodejs\npm.ps1` |
| python | True | `D:\python\python.exe` |
| java | True | `<local-java-runtime>\bin\java.exe` |
| javac | False |  |
| cl | True | `D:\Visual studio\VC\bin\amd64\cl.exe` |
| cmake | False |  |

## 自动结论

- 至少有一个 win64 游戏二进制与 Blindest v0.10 的 PE 指纹完全匹配。
- 已找到 Mathematica 自带的 Java 8，可显式指定其路径运行 DDSaveEditor；它没有加入 PATH。
- 已找到 MSVC `cl.exe`，具备尝试编译 Blindest C++ 源码的基础条件。
- 检测到 13 个 Workshop 内容目录；仅凭目录不能判断当前存档启用了哪些 Mod，需要后续从存档或游戏配置确认。
- 游戏根目录检测到非标准附加文件：`cream_api.ini`、`暗黑地牢1dlc补丁.exe`、`暗黑地牢1dlc补丁.zip`。运行时兼容性必须以当前实际环境测试，不假设为纯净 Steam 安装。

## 下一步

1. 当前 Steam win64 构建与 Blindest v0.10 指纹匹配，可以进入原版运行测试。
2. 选择独立测试档，并在采集前制作只读快照。
3. 解决 DDSaveEditor 的 Java 运行环境或采用可嵌入解析器。
4. 开启 Blindest 调试日志，手动完成一场普通战斗并采集关键节点。
