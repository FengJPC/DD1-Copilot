# DD1 Copilot

《Darkest Dungeon 1》的模型操作与决策辅助层。DD1 Copilot 为 Codex 整理当前决策所需事实，把语义动作落实为经过核对的游戏操作，并维护跨远征的英雄档案与复盘。Game MCP、Blindest 适配和命名管道是支撑 Copilot 的底层组件。

版本变化和当前待实机验收项见 [`CHANGELOG.md`](CHANGELOG.md)。当前 ID 接口和分层见 [`ID 动作契约`](docs/architecture/003-id-action-contract.md)，本轮审计见 [`审计记录`](docs/experiments/016-id-abstraction-audit.md)。

源码维护入口和两个模型入口的共同事务流程见 [运行结构](docs/architecture/004-runtime-structure.md)。

本轮更新已通过 113 项测试和 TypeScript 构建；结构拆分及确认弹窗已有城镇实测记录。新增的城镇资格、费用、疗养院原生操作及饰品读数需要匹配的本地修改版 DLL，仍待重启游戏实机验收，详见 [城镇修复与验收计划](docs/experiments/022-town-hardening-and-trinket-reminder.md)。

> **初版发布范围**：本仓库发布 MIT 许可的 Copilot、Game MCP、状态归约、测试和开发脚本。运行时命令依赖本地修改的 Blindest Dungeon；由于上游尚未明确允许再发布修改版源码和二进制，修改版源码、DLL、游戏文件和实机日志暂不随仓库分发。这会使当前公开版本无法单独完成端到端构建，待取得明确授权后将以保留上游历史的独立 fork 补齐。来源、依赖许可证和核查证据见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [第三方源码许可审计](docs/licensing/001-third-party-source-audit.md)。

## 当前能力

- 按需独立读取/解码存档，保存经过哈希验证的快照；日常状态查询只读日志；
- 尾读 Blindest Dungeon 的 `ddaccess-debug.log`；
- 解析战斗开始、行动者、技能武装、目标预览、战斗结算、敌人归零和战利品界面；
- 通过游戏主线程上的只读 `inspect_state` 快照取得当前敌我单位、生命/压力/状态和行动栏技能；
- 同一快照还提供房间物件、背包、事件选项与兼容物品、战利品清单；
- 通过只读 `inspect_map` 首次取得完整地图拓扑，并用轻量位置事件持续更新当前位置和访问状态；
- 用状态归约器输出当前战斗阶段和“战斗结束候选”；
- 用 DDSaveEditor 解码存档，确认 `inbattle`、敌人生命/状态、战斗计数和背包变化；
- 通过游戏主线程命令执行 ID 选择及必要的基础输入，保留游戏自身规则与结果核对；
- 用 `use_skill(actorGuid, skillElementId, targetGuid)` 表达战斗意图；出征任务、编队、补给分别使用任务 ID、英雄 GUID 和物品 ID；
- 对每一步保留传输回执和语义证据，遇到不确定状态立即停止，不盲目重发；
- 以稳定英雄 GUID 将档案、远征、已核验动作和模型复盘写入本地 SQLite，并可跨进程恢复或导出 Markdown；
- 已在老路末战完成从首回合到返回城镇的完整实战闭环，记录见 `docs/experiments/007-full-combat-mouse-loop.md`。

## 安装开发依赖

```powershell
npm install
```

## 分析已有日志

```powershell
npm run analyze:log -- .\fixtures\captures\<session>\ddaccess-debug.log
```

## 实时观察日志

```powershell
npm run observe:log -- "C:\path\to\DarkestDungeon\_windows\win64\ddaccess-debug.log"
```

加上 `--from-start` 会先回放当前日志，再继续尾读：

```powershell
npm run observe:log -- "C:\path\to\DarkestDungeon\_windows\win64\ddaccess-debug.log" --from-start
```

## 启动只读 Game MCP

设置 Blindest 日志路径后启动 stdio MCP：

```powershell
$env:DD1_BLINDEST_LOG = "C:\path\to\DarkestDungeon\_windows\win64\ddaccess-debug.log"
npm run mcp
```

当前工具为：

- `get_state`：只返回日常使用的 Blindest 实时状态，不触发存档解码；
- `get_events`：返回不会丢弃未知行的日志增量；
- `get_save_snapshot`：仅在显式调用时复制并解码存档检查点；
- `send_command`：向可选命名管道发送基础命令，只报告传输回执；
- `health`：分别检查日志、存档目录和命令通道，不启动解码器。

## 启动 Copilot 中间层 v0.2

需要启动带命名管道和静音设置的游戏时，直接双击仓库根目录的
`start_dd1_agent.cmd`。该入口会调用 `scripts/start_agent_game.ps1`；启动失败时窗口会保留错误信息。
启动器依次使用 `-GameDirectory`/`DD1_GAME_DIR`、仓库根目录的 `launcher.local.json` 中的 `gameDirectory`，或自动识别 Steam 游戏库。可以指定游戏根目录或 `_windows\win64`；本地配置不会提交 Git。迁移游戏后更新本地配置即可。
用 `start_dd1_agent.cmd -CheckOnly` 可检查路径而不启动游戏。

Copilot 复用相同的日志和命名管道配置，对 Codex 暴露带 revision 保护和语义结算的接口：

```powershell
$env:DD1_BLINDEST_LOG = "C:\path\to\DarkestDungeon\_windows\win64\ddaccess-debug.log"
$env:DD1_COMMAND_PIPE = "\\.\pipe\dd1-agent-bridge"
npm run copilot
```

当前工具为八个：

- `get_state`：返回面向当前选择的 `decision`，以及必要的城镇或战斗事实；
- `get_tactical_state`：战斗中始终返回当前技能完整说明和全体动态状态；角色详情、抗性、增益与战斗历史只在首次出现或变化时返回；
- `act`：接受一个模型已经决定的语义动作，并完成它所需的全部机械步骤；
- `get_briefing`：汇总近期或本次会话的动作结果；
- `get_campaign_resume`：读取跨会话英雄档案、远征、近期决策和复盘；
- `get_hero_memory`：只在编队、治疗或培养决策需要时，按稳定 GUID 展开一名英雄的完整档案与变化历史；
- `record_reflection`：保存带证据 revision 的战略复盘或后续计划；
- `export_campaign_journal`：把数据库导出为可读 Markdown。

正常游戏循环中，城镇、地图、事件和战利品使用 `get_state`；进入战斗后改用
`get_tactical_state`。首次调用建立战术基线，后续调用只追加变化。模型上下文丢失、
手动接管游戏或需要完整重新对账时，传入 `resetBaseline=true`。

当前语义动作：

- `open_town_location(locationId)`；
- `return_to_town()`，从远征或补给界面逐步返回并核对界面变化；
- `choose_dialog_option(optionIndex)`，提供确认框正文与回答标签，核对回答后的状态；
- `prepare_town_treatment(activityId, slot, heroGuid)`、`choose_town_treatment(activityId, slot, heroGuid, quirkId, mode)` 和 `confirm_town_treatment(activityId, slot, heroGuid)`，分别准备治疗、选择怪癖处理和确认提交；
- `travel_to_room(roomId)`，目标房间必须由模型从相邻房间列表中明确选择；
- `advance_corridor()`、`enter_room()` 和 `return_to_previous_room()`；
- `approach_room_prop(propIndex)` 和 `interact_room_prop(propIndex, heroGuid)`；普通奇物与陷阱都会先按稳定英雄 GUID 选择并核对实际交互者；
- `choose_event_option(optionIndex)` 和 `use_item_on_event(optionIndex, inventorySlot)`；
- `take_all_loot()`、`take_loot_item(itemIndex)` 和 `close_loot()`；
- `move_hero(toSlot)`；
- `use_inventory_item(inventorySlot, targetHeroGuid?)`（优先以英雄 GUID 直接提交并核对实际使用者；`targetIndex` 仅为旧版备用）、`discard_inventory_item(inventorySlot)` 和 `use_torch()`；
- `choose_camp_meal(optionIndex)`、`use_camp_skill(skillSlot, targetIndex?)` 和 `finish_camp()`；
- `retreat_combat()`、`abandon_expedition()`、`finish_quest()`；
- `choose_quest_completion(destination)` 和 `continue_results()`；
- `dismiss_modal()`；
- `use_skill(skillSlot, target?)`，技能详情为“目标无/Target: None”时省略 `target`；有目标时优先使用状态中的 `targetGuid` 直接提交，站位只作展示与旧版备用；
- `pass_turn()`；
- `cancel_targeting()`，仅用于对账或故障恢复。
- `assign_circus_contestant(heroAddress, rank)` 和 `activate_circus_hero(actorGuid)`，用于斗技场编队和按 ID 选择本回合行动者。

战斗回合中，`get_state` 会按需请求一次不改变游戏状态的 `inspect_state`。返回的 `decision` 只列当前行动者、双方单位、技能槽、目标候选和可提交动作。`use_skill` 的每一步都等待明确日志证据；仅收到 `queued` 或 `accepted=1` 不算语义成功。一次成功的 `use_skill`、`pass_turn` 或 `move_hero` 默认继续等待动画、敌方行动和回合交接，直到返回下一名可操作英雄的 `nextDecision`，或返回战斗结束后的 `nextState`。等待超时只会返回 `reconciled` 状态，不会重发已经提交的动作。

遇到外部操作、陈旧快照或 `uncertain` 时，可调用只读 `refresh_state(mode, afterRevision, includeMap)`。实机长连接提供等价的 `refresh` 操作。`state project=summary` 未显式指定 `mode` 时，第一次建立完整基线，之后自动使用上次 revision 请求增量；需要完整当前快照时显式传 `mode=compact`。

进入地下城后，第一次 `compact` 状态包含完整的已知地图拓扑。后续 `delta` 只返回 `mapUpdate.currentAreaId` 和 `visitedAreaIds`；逐行地图快照不会重复进入模型上下文。Copilot 只执行模型指定的 `travel_to_room(roomId)`，不会试探方向或替模型挑选出口。

房间或走廊里存在活动物件时，`decision` 会先给出接近或交互动作，暂时隐藏继续前进和路线选择。事件界面只会把游戏内存已确认兼容的背包物品列为 `use_item_on_event`，以免误耗补给。

出征和补给界面通过 `advisories.prepare_trinkets` 提醒配置当前队伍的饰品，按英雄 GUID 显示两格装备，并区分已装备、空槽和未知。当前尚无经过实机核验的饰品装卸动作，需要人工协助配置。

战利品窗口在背包已满且目标物品确实无法并入现有堆叠时，才会提供 `replace_inventory_with_loot(inventorySlot, itemIndex)`，由 Copilot 完成丢弃指定背包格、返回战利品窗口和拾取指定物品。单件拾取后会立即刷新背包和剩余战利品，避免下一次决策沿用拾取前缓存。低于 50 的光照会在 `advisories` 中给出显著提示，并附带当前火把数量；是否点火仍由模型决定。

本地实机调试可在完成 `npm run build` 后启动持久会话：

```powershell
$env:DD1_BLINDEST_LOG = "C:\path\to\DarkestDungeon\_windows\win64\ddaccess-debug.log"
$env:DD1_COMMAND_PIPE = "\\.\pipe\dd1-agent-bridge"
npm run copilot:live
```

该进程逐行接收 JSON。`{"op":"state","project":"summary"}` 返回紧凑状态；`{"op":"act_current","requestId":"...","action":{...}}` 在进程内读取最新 revision 后执行一次动作。战斗动作默认组成一个完整事务：执行与核对本次动作，等待到下一次玩家决策，再直接返回精简的 `transition` 与 `nextDecision`。调试时可传 `"waitForNextDecision":false` 只等待本次动作结算；`waitTimeoutMilliseconds` 只表示最长交接等待，默认 30 秒，可显式指定 1–60 秒，新的玩家决策一出现就立即返回。它保留同一个日志源和 Copilot 实例；启动前应先停止同一游戏管道对应的另一 Copilot 进程。输入 EOF 或 `stop` 会关闭数据库、取消等待并释放进程所有权。`resume` 默认只读取战役概览，`hero_memory` 按 GUID 展开一名英雄；`reflect`、`memory_status` 和 `export_memory` 分别用于写入复盘、检查数据库和导出 Markdown。诊断时可用 `{"op":"resume","detail":"full"}` 读取完整存储视图。

调用方应在读到一行完整 JSON 后立即处理响应。不要把终端或管道的最长等待窗口当成固定动作延迟；若短等待内尚未收到完整行，再继续轮询同一请求。战斗动作出现伤害、治疗或增益等语义证据后，若行动者与 `turnTick` 尚未变化，状态会暂时返回 `combat_resolving` 且不提供动作选项，避免动画期间对旧回合重复下令。

长期数据库默认位于 `%LOCALAPPDATA%\DD1AgentBridge\campaigns\<campaignId>\campaign.sqlite`。`campaignId` 优先取 `DD1_CAMPAIGN_ID`，否则取 `DD1_SAVE_DIR` 的目录名；可用 `DD1_MEMORY_DB` 指定数据库位置。活动 SQLite/WAL 文件应留在本地目录，Markdown 导出可放进项目或坚果云。

Copilot 不包含自动战斗策略或战斗风格评分器。Codex 负责每一次战斗、探索和城镇决策；中间层只整理事实、列出可用语义动作、执行一次并验证结算。

`get_state` 的信息档位：

- `compact`：当前决策状态、当前阶段所需事实、首次地图拓扑和被压缩诊断噪声的计数；
- `delta`：指定 revision 之后的相关事件、地图位置/访问摘要和噪声汇总；
- `full`：保留缓冲区内全部原始记录，同时附带筛选预览，便于核对筛选器是否漏掉信息。

筛选只发生在 Copilot。Game MCP 的 `get_events` 仍然无损保留每一条日志行。

当前状态归约会把城镇建筑列表、建筑中的英雄行、焦点英雄职业与等级、教程弹窗，以及战斗单位和行动栏合并为结构化状态。只读快照的逐行日志在 Copilot 中只计数，不重复塞入最近事件。

若要启用独立存档核对源，设置 `DD1_SAVE_DIR`、`DD1_SAVE_EDITOR_JAR` 和 `DD1_JAVA_EXECUTABLE`。日常状态读取不会调用它；只有 `get_save_snapshot` 才运行 DDSaveEditor。命令通道通过 `DD1_COMMAND_PIPE` 配置，游戏侧 Blindest 适配支持语义动作、兼容按键/元素操作、只读 `inspect_state` 和只读 `inspect_map`；斗技场编队可按英雄地址与站位直接执行，实战可按 actor GUID 选择行动者，再复用通用技能与目标 ID 接口。

分层设计见 `docs/architecture/001-mcp-copilot-layers.md`，长期存储见 `docs/architecture/002-campaign-memory.md`，Game MCP 与中间层接口分别见 `docs/protocol/game-mcp-v1.md` 和 `docs/protocol/copilot-v1.md`。

## 验证

```powershell
npm run typecheck
npm run build
npm test
```

维护者若另外持有本地 Blindest Dungeon 源码树，可运行其 `Mod\build.ps1 -NoDeploy` 构建 DLL；该第三方源码树不在本仓库内。新的斗技场实战接口仍需在练习赛中完成实机验收后再视为可用。

实机存档、解码结果和日志位于 `fixtures/captures/`，默认不会被 Git 跟踪。

## 许可证与第三方组件

本项目原创的 MCP、Copilot、中间层、测试、脚本、文档以及未来的 Codex
插件采用 [MIT License](LICENSE)。MIT 许可证不覆盖 Blindest Dungeon、存档
编辑器、参考项目、游戏文件或其他第三方内容；这些内容的来源和边界见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`references/`、本地构建的 DLL、安装器、游戏存档和运行日志默认不进入公开
仓库。Blindest Dungeon v0.10 的发布说明允许任何人查看和任意修改源码；在
上游给出标准许可证或进一步明确再发布条件前，其修改源码和二进制继续单独
标注，不适用本项目根目录的 MIT 许可证。

## 命令通道安全边界

命名管道由游戏进程按当前用户 ACL 创建，也可通过 `DD1_AGENT_CLIENT_SID` 允许指定的本地沙箱账户。`queued` 或 `accepted=1` 只表示命令进入游戏线程；Copilot 必须继续等待日志、内存状态或界面状态的语义结果，才能报告动作成功。`scripts/send_game_key.ps1` 仅保留为白名单按键的兼容调试工具，正常流程优先使用 ID 语义接口。
