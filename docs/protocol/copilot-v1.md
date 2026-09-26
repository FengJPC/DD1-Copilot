# DD1 Copilot v1 接口

> 2026-09-26 更新：当前 ID 接口与必需参数以 [ID 动作契约](../architecture/003-id-action-contract.md) 为准。编队 `frontToBack` 已改为整数英雄 GUID；本页早期按名字/按键循环的示例属于历史实现。
日期：2026-09-25

## 目标

Copilot 是模型使用的中间层。模型决定做什么；Copilot 负责给出当前选择所需事实，并把一个语义动作可靠地落实为若干基础输入。

## 工具

### `get_state`

`compact` 是正常决策入口。核心字段：

- `revision`：下一次 `act` 必须原样带回；
- `phase` 和 `context`：当前界面阶段；
- `decision`：当前问题、技能或城镇选项和目标候选；
- `combat`：当前行动者、双方单位的状态/抗性、技能槽及其完整说明、最近结算；
- `map`：首次地下城状态中的完整已知拓扑、房间/走廊、可见内容和访问状态；
- `room.props` 与 `inventory`：当前可交互物件、背包容量/占用数及非空格；
- `light`、`camp`、`quest`、`results`：光照、扎营选择、任务目标/撤退控制和远征结算页；
- `event`：事件文本、选项，以及游戏已确认兼容的背包格；
- `loot`：当前战利品的名称、数量和索引；
- `recentInformation`：最近相关事件、未分类样本和已压缩噪声计数。

`delta` 用于继续读取某个 revision 之后的变化。地图变化被压成 `mapUpdate.currentAreaId` 和 `visitedAreaIds`，不会重复返回完整快照。`full` 用于审计原始日志和筛选结果。

普通战斗决策示例：

```json
{
  "revision": 120,
  "phase": "combat",
  "decision": {
    "kind": "combat_turn",
    "actor": {
      "name": "Dismas",
      "heroClass": "强盗",
      "currentHp": 19,
      "maxHp": 23,
      "stress": 7
    },
    "skills": [
      { "skillSlot": 1, "name": "手枪射击" }
    ],
    "targets": [
      {
        "side": "enemy",
        "slot": 2,
        "name": "邪教徒斗士",
        "currentHp": 15,
        "maxHp": 15
      }
    ]
  }
}
```

### `act`

请求必须包含：

- 全新的 `requestId`；
- 最近一次观察到的精确 `expectedRevision`；
- 一个语义动作。

可选的 `rationale` 用于记录模型在关键节点的简短决策依据。它不会参与输入执行，但会随动作记录进入 `get_briefing`，适合录屏侧栏和复盘。

`use_skill`、`pass_turn` 和 `move_hero` 成功后，`act` 默认继续等待到下一名可操作英雄或战斗结束。可选参数：

- `waitForNextDecision`：默认 `true`；设为 `false` 时只返回本次动作的结算；
- `waitTimeoutMilliseconds`：交接等待上限，默认 45000，范围 1000–60000。

同一 `requestId` 和完全相同的请求可安全重取结果，不会再次发送输入。同一 ID 对应不同请求会在发送前失败。revision 已变化时也会在发送前失败。

`use_skill` 示例：

```json
{
  "requestId": "turn-7-dismas-1",
  "expectedRevision": 120,
  "action": {
    "kind": "use_skill",
    "skillSlot": 1,
    "target": {
      "side": "enemy",
      "slot": 2
    }
  }
}
```

Copilot 依次执行：

1. 按下技能槽快捷键；
2. 等待日志确认该技能已武装并打开目标列表；
3. 循环目标，直到日志中的阵营和位置与请求一致；
4. 确认目标；
5. 等待战斗文字、状态变化、下一行动者、敌人数量或战斗结束等结算证据；
6. 动作验证成功后继续经过动画和敌方回合，直到结构化状态确认下一名活跃英雄。

默认响应在 `action` 外还会包含：

- `transition`：等待结果和精简后的伤害、增益、换人、敌人数量变化或战斗结束事件；
- `nextDecision`：下一回合可直接决策的战术帧；
- `nextState`：战斗已结束时的当前状态；
- `reconciled`：等待超时时的对账状态。超时不会再次发送已经确认过的动作。

`pass_turn` 会点击只读行动栏快照中观察到的“跳过回合”元素，并等待下一行动者或其他战斗结算证据。模型必须显式选择跳过；中间层不会因为没有合适技能而自行跳过。

`travel_to_room(roomId)` 只接受当前地图中与当前位置直接相邻的房间。Copilot 先把地图光标复位到队伍当前位置，再按该边的确切方向选择目标并确认移动。它不会遍历方向、选择第一个可走出口或根据房间内容替模型决定路线。

探索阶段动作包括：

- `advance_corridor`、`enter_room`、`return_to_previous_room`；
- `approach_room_prop(propIndex)`、`interact_room_prop(propIndex, heroGuid)`；`heroGuid` 是稳定档案 ID，中间层必须在激活奇物前核验 DLL 已选中同一英雄；
- `choose_event_option(optionIndex)`、`use_item_on_event(optionIndex, inventorySlot)`；
- `take_all_loot`、`take_loot_item(itemIndex)`、`close_loot`。

探险闭环动作还包括：

- `move_hero(toSlot)`：在战斗中选择“移动”，核对合法目标并等待队伍顺序变化；
- `use_inventory_item(inventorySlot, targetIndex?)`、`discard_inventory_item(inventorySlot)`、`use_torch`；
- `choose_camp_meal(optionIndex)`、`use_camp_skill(skillSlot, targetIndex?)`、`finish_camp`；
- `retreat_combat`、`abandon_expedition`、`finish_quest`；
- `choose_quest_completion(destination)`，其中 `destination` 为 `hamlet` 或 `continue`；
- `continue_results`：逐页推进结算，等待页码变化或界面关闭。

物品的 `targetIndex` 与扎营技能的 `targetIndex` 是游戏目标列表中的零基索引；省略时选择第一个合法目标。丢弃、撤退和放弃远征在确认弹窗出现后才会确认，并继续等待物品数量或界面状态变化。

房间物件存在时，路线动作会在验证阶段被拒绝。`use_item_on_event` 只接受当前事件快照标为兼容的非空背包格。接近物件后会重新读取内存，只有距离减小或物件变为可达才报告成功。

如果技能无法选择、目标不合法或输入被底层拒绝，返回 `failure`。如果回执超时或无法证明界面所处状态，返回 `uncertain` 并停止后续步骤。

### `get_briefing`

返回最近十次或本次会话的语义动作、结果计数、分步证据和当前阶段。它用于复盘执行可靠性，不生成战术评分。

## 结果解释

| 结果 | 含义 | 后续 |
| --- | --- | --- |
| `success` | 已观察到该语义动作的完成证据 | 战斗动作通常直接读取返回的 `nextDecision` |
| `failure` | 参数、阶段、合法性或底层输入被明确拒绝 | 重新读取状态再决定 |
| `uncertain` | 输入是否执行或界面是否结算无法证明 | 不重发原 requestId，先对账 |

命名管道的 `queued` 和日志中的 `accepted=1` 只证明基础输入进入了游戏路由，不能单独构成 `success`。
