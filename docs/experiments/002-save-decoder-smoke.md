# M0 存档解码冒烟测试

> 日期：2026-09-24
> 范围：只读复制和解码，不修改原始存档，不启动游戏。
## 环境

- DDSaveEditor：v0.0.70；
- JAR SHA256：`FD7A052F5DA21FDE991893BC3D5AE9B03DBC59A9002B206388C3396199E10B90`；
- Java：Mathematica 自带 64 位 Java 8 `1.8.0_201`；
- 输入：`profile_1` 中已有的旧 `persist.raid.json`，先复制到临时目录；
- 输出：临时目录中的 UTF-8 JSON。

## 结果

- 解码进程退出码为 0；
- 5,044 字节的 DSON 存档生成 5,842 字节的有效 JSON；
- JSON 根节点为 `base_root`；
- 能读取 `raid_instance`、`party`、`stat_database`、`camp`、`inbattle`、`loot` 等字段；
- 原始文件的路径、大小和修改时间没有被写入操作改变。

## 只读 MCP 验证

使用 `darkest-dungeon-mcp`、同一 DDSaveEditor JAR 和 `profile_0` 完成 live-state 验证，得到以下根级结构：

```text
versions
roster
estate
town
quests
upgrades
```

这证明现有参考项目可以在本机完成“复制存档 → 解码 → 标准化”的闭环。

## 发现的问题

1. Mathematica 自带的旧 Java 8 无法稳定访问含中文字符的绝对 JAR 参数；把 JAR 复制到 `%TEMP%\DD1AgentBridge\tools` 后运行正常。
2. `darkest-dungeon-mcp` 的类型检查通过；测试结果为 225 通过、1 失败、2 跳过。唯一失败来自 Node 26 下 null-prototype 对象与普通对象的 `deepStrictEqual` 差异，与存档解析无关。
3. `profile_0` 有完整城镇数据但没有 `persist.raid.json`；`profile_1` 有旧的 raid 文件，但缺少 MCP 当前要求的 town 和 quest 组件。正式战斗采集应使用新建或明确指定的测试档。

## 结论

存档解码链可以用于 M1。下一步需要在游戏运行时采集同一动作前后的存档和 Blindest 日志，以测量刷新延迟并确认战斗字段覆盖。
