# Fixtures

`captures/` 用于保存本机测试档、解码结果和战斗采集数据。该目录默认被 `.gitignore` 排除，避免把个人存档、Steam 账户信息或大体积运行数据提交到版本库。

正式加入仓库的测试 fixture 必须经过脱敏，并尽量缩减为能够复现单个解析或状态转换问题的最小数据集。

## 实机采集

先确认专用测试档对应的 `profile_N`，再运行：

```powershell
pwsh -File .\scripts\capture_live_session.ps1 -Profile profile_N
```

脚本每 250 ms 检查一次存档目录，只在文件发生变化时保存带哈希的副本；停止时还会复制 Blindest 的 `ddaccess-debug.log`。采集结果写入 `fixtures/captures/`，默认不会被 Git 跟踪。
