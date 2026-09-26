# 009：Blindest 命令管道原型

日期：2026-09-25

## 目的

为 Game MCP 的 `send_command` 提供真正位于游戏进程内的命令接收端，同时保持默认关闭，并把战术判断留在外部 Copilot 中间层。

## 原型位置

- 仓库：`references/Blindest-Dungeon`
- 本地分支：`dd1-agent-ipc-prototype`
- 新模块：`Source/Mod/src/bridge/agentipc.cpp`

## 设计

1. 只有游戏进程设置 `DD1_AGENT_PIPE` 时才启动命名管道服务。
2. 管道线程只解析、校验和排队命令，不直接读取或修改游戏对象。
3. `OurPoll` 在游戏主线程中取出一条命令并调用现有合成输入能力。
4. `key_press` 先经过 Blindest 的按键路由；未被辅助功能路由接管时再作为 SDL 按下/松开事件交给游戏。
5. `click_element` 使用 Blindest 已有的元素点击函数。
6. 管道回复 `queued` 只表示命令进入游戏线程队列，不表示游戏动作完成。
7. 使用 `PIPE_REJECT_REMOTE_CLIENTS`，并且默认不启动管道。

## 当前支持的基础命令

```json
{"kind":"key_press","args":{"sym":49,"mod":0}}
```

```json
{"kind":"click_element","args":{"elementId":"0x1234"}}
```

## 验证状态

- TypeScript 端命名管道协议测试通过。
- Blindest 修改已通过 `git diff --check`。
- 已使用 MSVC 19.44 完整编译并部署到游戏目录。
- 游戏进程内的管道监听、拒绝无效命令、排队有效命令和主线程取队列均已验证。
- 实际按键效果仍待单独验证；当前只发送过不会触发操作的无效键码 `0`。
- 详细记录见 `010-blindest-command-pipe-live.md`。

## 合并条件

1. v0.10 release 已明确允许检查和任意修改；公开发布修改版源码或 DLL 前仍需确认具体再发布条款。
2. ~~使用支持 C++17 的 MSVC 编译完整 DLL。~~ 已完成。
3. ~~在关闭游戏时备份当前 DLL，再部署测试版本。~~ 已完成。
4. 已完成无操作启动和管道健康验证；普通实体按键与可逆游戏命令待验证。
