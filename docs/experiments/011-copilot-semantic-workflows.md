# Copilot 语义工作流离线验收

日期：2026-09-25

## 目标

把中间层调整为模型全程决策、Copilot 完成机械执行：

- 模型只接收简练但足够作出当前选择的状态；
- 模型提交一个完整意图，例如“技能槽 1 攻击敌方 2 号位”；
- Copilot 负责技能选择、目标移动、确认、动画等待和结算核对；
- 任一步证据不足时停止，不自动重复输入。

## 实现

### 只读战斗快照

游戏侧新增默认关闭的 `inspect_state` 命令。命令在游戏主线程读取：

- 当前敌我单位、位置和稳定地址；
- 生命、压力和状态效果；
- 当前行动者；
- 行动栏技能槽及其他动作元素。

它只写入 `agent-state` 日志，不发送键鼠输入。Copilot 在新的英雄回合最多请求一次，并把日志块归约为结构化状态。

### 模型状态

`get_state(compact)` 增加 `decision`：

- 城镇：只列已解锁且可打开的地点；
- 弹窗：给出弹窗内容和关闭动作；
- 战斗：给出当前行动者、双方单位、技能槽、目标候选和跳过回合；
- 已打开目标列表：进入恢复状态，只允许取消后重新观察。

快照逐行日志不会重复出现在最近信息中，只汇总为 `agent_state_snapshot` 计数。`full` 仍保留原始记录供审计。

### 语义执行器

当前动作：

- `open_town_location`；
- `dismiss_modal`；
- `use_skill`；
- `pass_turn`；
- `cancel_targeting`。

`use_skill` 拆成三个或更多可审计步骤：

1. 选择技能并等待 `skill_armed`；
2. 循环目标并等待新的 `target_preview`；
3. 确认并等待战斗文字、状态变化、行动者变化、敌人数变化或战斗结束。

每一步记录基础命令、传输回执、起止 revision、观察事件与 `success | failure | uncertain`。整个请求使用 `requestId` 去重，并要求精确的 `expectedRevision`。

## 验证

```powershell
npm test
npm run typecheck
npm run build
pwsh -File .\references\Blindest-Dungeon\Source\Mod\build.ps1 -NoDeploy
```

结果：

- 10 个 TypeScript 测试全部通过；
- 类型检查通过；
- TypeScript 构建通过；
- MSVC 编译生成 `ddaccess.dll`，大小 2,077,696 字节；
- 使用 `-NoDeploy`，未修改游戏目录。

真实日志回放结果：

- revision：3674；
- 当前阶段：`building`；
- 当前建筑：`stage_coach`；
- 城镇地点：10；
- 最近 500 条内未分类日志：0；
- 已压缩诊断日志：461。

## 尚未完成

- 新 `inspect_state` DLL 尚未部署；
- 只读快照尚未与测试档画面逐项核对；
- `use_skill` 与 `pass_turn` 尚未在新 DLL 上完成真实单回合验收；
- 换位、撤退、探索、战利品和城镇管理动作仍待扩展。

实机验收顺序：

1. 游戏关闭时部署新 DLL；
2. 启动测试档并进入普通战斗；
3. 只调用 `get_state`，核对行动者、单位、生命、压力和四个技能；
4. 由模型选择一个低风险技能和目标；
5. 调用一次 `act`，对照画面、日志和返回的步骤证据；
6. 若结果为 `uncertain`，只重新观察，不重复原请求。
