# M0 Blindest v0.10 安装记录

> 日期：2026-09-25
> 范围：安装发行包中的运行文件，不启动游戏、不修改存档。

## 安装目标

- 游戏目录：`E:\SteamLibrary\steamapps\common\DarkestDungeon\_windows\win64`；
- 安装包：`references/Blindest-Dungeon/BlindestDungeon-v0.10.zip`；
- 安装包 SHA256：`3B199AA12AF0168AF5B07BCB0DC16E0E032CC57E14BA9BE79E640F3DB6EF4FF9`。

安装前确认 `Darkest.exe` 与 `DarkestAccess.exe` 均未运行，目标目录不存在三个同名文件，因此没有覆盖旧版模组。

## 已安装文件

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `DarkestAccess.exe` | 213,504 | `DBB2169C090C0AADD291DEBC97BA963696AE349C970D5A596A26AA53B4A037B6` |
| `ddaccess.dll` | 2,069,504 | `EFC6C528EAC8050C6222A5DEEEBBEDAD892032DDC19241093B81E879E6CA1041` |
| `prism.dll` | 1,180,672 | `CB9712E11AF9EBE96457DBF8F5DAAD4A6C359AE1F59CDF2663282B3A9CC9759C` |

复制后逐一比较源文件和目标文件 SHA256，三项均一致。`DarkestAccess.exe` 的文件版本和产品版本均为 `0.10`。

已创建 `%LOCALAPPDATA%\DarkestAccess\settings.ini`，其中 `debug_log=1`。该目录此前不存在配置文件，因此没有覆盖用户已有的模组设置。

## 恢复信息

安装前清单位于 `backups/blindest-preinstall-20260925-001749/manifest.json`。由于目标目录此前没有这些文件，恢复到安装前状态只需在游戏关闭时移除上述三个文件。

## 下一步

1. 通过 `DarkestAccess.exe` 启动游戏，确认启动器成功加载 `ddaccess.dll` 并生成 `ddaccess-debug.log`；
2. 新建独立测试档；
3. 运行 `scripts/capture_live_session.ps1`，完成一场手动普通战斗。
