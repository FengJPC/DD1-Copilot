# 008：Game MCP v0.2.1 验证

日期：2026-09-25

## 目标

验证 Game MCP 能把 Blindest 日志、存档检查点和命令传输保持为三个独立通道，其中日常状态读取不得触发存档解码。

## 实现

- `get_state`：只读取 Blindest 日志状态。
- `get_events`：以每条日志行为 revision，保留无法识别的行。
- `get_save_snapshot`：显式调用才稳定复制并解码全部 `persist.*.json`。
- `send_command`：通过命名管道发送 `{ kind, args }`，只返回传输回执。
- `health`：检查日志、存档目录和命令通道；只读取存档目录元数据。

## 实机结果

- MCP 协议版本：`2025-11-25`。
- 服务版本：`dd1-game-mcp 0.2.1`。
- Blindest 日志：260,309 字节，共 2,413 条非空记录，其中 148 条已结构化解析。
- `profile_2`：发现并成功解码 14 个存档文件，0 个错误。
- 独立性验证：在新 MCP 进程中先调用 `get_state`，随后 `health` 返回 `cachedRevision=0`、`cachedFileCount=0`，证明日常状态读取没有启动 DDSaveEditor。
- 无损性验证：未识别的城镇闲聊、语音和输入诊断日志均能通过 `get_events` 返回。
- 命令传输测试：测试命名管道收到 `select_skill`，返回 `queued`；MCP 未把它报告为 `executed`。

## 自动检查

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：2 项通过，0 项失败。

## 尚未接通

`send_command` 的 MCP 客户端和 JSONL 协议已经完成，真实游戏侧的命名管道服务尚未加入 Blindest。未配置 `DD1_COMMAND_PIPE` 时会明确返回 `unavailable`。
