# ID 动作契约

更新：2026-10-06。本文件描述当前实现；最新测试与部署状态见实验 026。

## 边界

模型决定任务、阵容、技能、目标、路线和资源投入。Copilot 接收决策、解析当前身份、完成机械操作并核对结果。DLL 只查询游戏状态并调用已有操作路径。存档解码是独立、低频、显式的信息源。

```text
模型：观察一次基线 → 后续差量 → 选择 ID 与动作
  ↓
action-schema.ts：唯一动作定义、运行时校验、派生 TypeScript 类型
  ↓
identity.ts：ID/位置解析，冲突、缺失、重复 ID 检查
  ↓
engine.ts：版本检查、并发互斥、单次执行、语义证据、下一决策点
  ↓
GameGateway → 命名管道 → DLL 主线程：重新查询 ID、验证前置条件、操作
  ↑
日志 → 归约状态 → 战术摘要/动作摘要 → 模型
```

`engine.ts` 协调版本检查、执行和回执；场景工作流在 `workflows/`，共用步骤执行、身份、物品事务与输出各自独立。

## 身份

| 字段 | 用途 | 生命周期 |
|---|---|---|
| `heroGuid` / `targetHeroGuid` | 英雄档案、出征编队、物品与营地的英雄选择 | 当前存档；不同存档不可混用 |
| `actorGuid` / `targetGuid` | 当前战斗行动者/敌我目标 | 当前运行的最新快照 |
| `skillElementId` | 当前行动者技能栏里的具体技能元素 | 当前行动栏；不当作永久技能 ID |
| `questId` | 当前周可选任务 | 当前任务列表；重复 ID 会被拒绝 |
| `itemKey` | 补给物品种类，例如 `food`、`torch` | 从当前补给列表读取 |
| `itemId` | 饰品种类身份 | 当前库存或已装备槽；多份同 ID 用库存格区分 |
| `inventorySlot` | 当前物品格 | 当前 revision；DLL 另核对 key 和原数量 |

不能从名字、角色职业或队伍下标推测 ID。旧日志没有运行时 ID 时，食物与营地单体目标不会退回按键计数；旧战斗 side/slot 输入仍保留逐步目标预览核对的兼容路径。

## 模型接口示例

每个 `act` 携带新的 `requestId` 与最近的 `expectedRevision`。下面仅展示 `action` 对象；示例 ID 必须替换成当前观察值。

```json
{"kind":"use_skill","actorGuid":107,"skillElementId":"0x736b6c6c","target":{"targetGuid":205}}
```

```json
{"kind":"use_inventory_item","inventorySlot":3,"targetHeroGuid":7}
```

```json
{"kind":"use_camp_skill","skillSlot":1,"targetHeroGuid":8}
```

```json
{"kind":"select_embark_quest","questId":"当前观察的任务ID"}
```

```json
{"kind":"form_embark_party","frontToBack":[7,8,9,10]}
```

```json
{"kind":"buy_provision","itemKey":"torch","quantity":8}
```

`frontToBack` 从前排 rank 1 到后排 rank 4，元素已改为整数 GUID，旧名字数组会报校验错误。补给购买每件只提交一次，观察交易后继续；最终核对所有堆叠合计和可用的钱包数据。编队每次分配后等待实际站位，再检查最终全部四位。

## 结果与紧凑输出

- `success`：已见对应的游戏结果证据。
- `failure`：校验拒绝、游戏拒绝或已观察到不符合预期的结果；先刷新再决定。
- `uncertain`：超时、连接断开或证据不足；不要重发操作。

同 ID、同请求在执行中共享结果，执行后可从缓存及战役 SQLite 回执恢复；跨进程恢复不会重放已记载的请求。相同 ID 改动作或 revision 会被拒绝。旧 revision 遇到状态变化仍拒绝，完整且只有明确诊断的增量按专门规则放行。其他动作在执行期间拒绝；读取状态可继续，但不会插入自动地图操作。

MCP `act` 默认返回动作、简短原因、版本、步骤结果；完整日志不在每次回合重复发送，`includeEvidence=true` 可显式展开。完整动作记录仍进入战役记忆。普通状态不自动混入存档解码。

## DLL 原语

| 命令 | 参数 | 执行前核对 |
|---|---|---|
| `activate_combat_skill` | `actorGuid, skillElementId` | 当前英雄、行动资格、技能栏元素 |
| `commit_combat_target` | `actorGuid, skillElementId, targetGuid` | 已武装技能、行动者、唯一合法目标 |
| `commit_item_target` | `targetGuid, inventorySlot, expectedAmount, itemKey` | 选择器、当前物品身份/数量、唯一目标 |
| `commit_camp_target` | `actorGuid, skillElementId, targetGuid` | 休整阶段、当前人物、已武装技能、目标 |
| `assign_party_hero` | `heroGuid, position` | 活动远征界面、候选唯一、英雄可用、目标位置 |
| `select_embark_quest` | `questIndex` | 模型任务 ID/实例解析到当前唯一任务位置 |
| `buy_provision` | `itemKey` | 当前商店唯一物品、库存、交易未处理中 |
| `equip_trinket` | `heroGuid, slot, itemId, inventorySlot` | 阶段、构建、英雄、职业限制、空目标槽、源物品与数量 |
| `unequip_trinket` | `heroGuid, slot, itemId` | 阶段、构建、英雄、已装备身份、仓库空格 |

DLL 的 `agent-command: begin/end id=...` 只表示关联和游戏线程接收，不能单独证明消费、伤害或编队完成。物品额外输出实际使用者、物品格、调用结果与数量变化。
