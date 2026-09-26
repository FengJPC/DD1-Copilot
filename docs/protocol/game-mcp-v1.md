# DD1 Game MCP v1 协议

> 2026-09-26 更新：当前 ID 接口与必需参数以 [ID 动作契约](../architecture/003-id-action-contract.md) 为准。编队 `frontToBack` 已改为整数英雄 GUID；本页早期按名字/按键循环的示例属于历史实现。
日期：2026-09-25

## 边界

Game MCP 是无策略的信息与命令通道。它不推断当前应该做什么，也不判断命令产生的游戏效果是否符合预期。

## MCP 工具

### `get_state`

只返回日常实时来源：

- Blindest 日志归约出的当前状态；
- 当前日志游标、已解析事件数和缓冲窗口；
- 日志路径、观测时间和健康状态。

`structured` 省略事件对象中重复的原始日志文本；`full` 保留这些文本。两者不删除任何已解析的游戏字段。

这个工具不读取或解码存档。

### `get_save_snapshot`

这是独立的低频核对源。只有显式调用才会：

1. 稳定读取发生变化的 `persist.*.json`；
2. 将副本写入临时缓存；
3. 启动 DDSaveEditor 解码；
4. 返回全部文件的原始解码结构和独立 save revision。

建议只在战斗结束、房间或城镇切换、日志超时、状态冲突和模型显式核对时调用。同一 MCP 进程内未变化的文件复用缓存，不重复启动解码器。

### `get_events`

返回 Blindest 日志的无损增量流。每条非空日志行都有独立 revision：

- 能识别的行同时含结构化 `event`；
- 暂时无法识别的行仍保留 `message` 和可选 `raw`；
- `truncated=true` 表示请求游标早于内存缓冲窗口，中间层应重新读取完整状态。

### `send_command`

把 `{ kind, args }` 包装为命令信封并发送至 `DD1_COMMAND_PIPE`。返回值只表示传输结果：

- `accepted`：游戏侧桥接已接受；
- `queued`：游戏侧桥接已排队；
- `rejected`：游戏侧桥接明确拒绝；
- `unavailable`：命令通道不可连接；
- `timeout`：结果未知，中间层不得盲目重发。

### `health`

分别报告日志、存档目录和命令通道的状态。`health` 只检查存档目录元数据，不触发解码。命令通道未配置不影响只读信息源的使用。

## 命名管道 JSONL

默认建议管道名：

```text
\\.\pipe\dd1-agent-bridge
```

MCP 进程使用 `DD1_COMMAND_PIPE`；Blindest 本地原型使用 `DD1_AGENT_PIPE`。两者必须设置为同一个管道名。Blindest 侧未设置环境变量时保持关闭。

当前游戏侧原型接受四种基础命令：

- `key_press { sym, mod }`：把一个 SDL 键交给 Blindest 的现有路由；
- `click_element { elementId }`：点击日志已经暴露的稳定界面元素；
- `inspect_state {}`：在游戏主线程只读枚举当前战斗单位和行动栏，并写出 `agent-state` 日志块。
- `inspect_map {}`：只读枚举游戏已知的地图拓扑、房间/走廊、可见内容和访问状态，并写出 `agent-map` 日志块。
- `assign_circus_contestant { heroAddress, rank }`：按当前斗技场选手的稳定内存地址分配到第 1–4 站位，并以独立的槽位观察结果确认执行。
- `activate_circus_hero { actorGuid }`：在屠夫马戏团的选人窗口按运行时角色 GUID 调用游戏内部 `Battle::ActivateHero`。DLL 只有在角色真正取得行动权和行动栏后才写出 `observed=1`；后续技能与目标继续使用通用的 ID 接口，并由竞技场专用状态机提交回合。

`inspect_state` 和 `inspect_map` 都不选择动作，也不产生键鼠输入。Copilot 在新的英雄回合按需调用前者，在首次进入房间或需要对账时调用后者。移动过程中游戏侧只在区域变化时写一条 `agent-map: position`，供 Copilot 生成轻量地图增量。

请求每行一个 JSON 对象：

```json
{
  "protocolVersion": 1,
  "commandId": "uuid",
  "sentAt": "ISO-8601",
  "command": {
    "kind": "key_press",
    "args": {
      "sym": 49,
      "mod": 0
    }
  }
}
```

游戏侧必须用同一 `commandId` 回复：

```json
{
  "commandId": "uuid",
  "status": "queued"
}
```

Game MCP 不把这条回复升级为 `executed`。Copilot 中间层必须继续观察日志或存档并自行判断结算。

模型不会直接组合这些基础命令。Copilot 的 `act` 接受 `use_skill(skillSlot, target)` 等语义动作，并负责按顺序发送、等待和核对每个机械步骤。

## 当前状态

- 日志通道：已在真实 `ddaccess-debug.log` 上验证。
- 存档通道：已在 `profile_2` 上一次性解码全部 14 个存档文件，无错误。
- MCP 协议：已完成 `2025-11-25` 握手和工具调用。
- 命令客户端：已实现。
- 游戏侧命名管道服务：本地原型已用 MSVC 19.44 编译和部署；管道健康、协议回复、游戏主线程取队列与真实按键效果均已验证。`C` 键已通过同一管道实际打开驿站马车。
- `inspect_state`：源码与日志解析已经完成并通过离线编译；新 DLL 尚未部署，需在测试档实机核对输出。
- `inspect_map` 与区域位置事件：源码、解析、状态归约和 Copilot 压缩均已通过自动化测试与离线 DLL 编译；新 DLL 尚未部署，需在测试档实机核对。
- Copilot：城镇入口、弹窗、目标恢复和完整技能目标工作流已通过自动化回放；真实单回合验收待进行。
