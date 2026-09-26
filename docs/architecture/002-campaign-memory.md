# 人物档案与远征记录的长期维护

日期：2026-09-25

## 分工

中间层负责可核对事实，我负责战略解释。两类内容都由中间层落盘，避免模型上下文压缩、任务重启或版本更新造成遗失。

### 中间层事实库

- 英雄档案：稳定英雄 ID、姓名、职业、等级、技能、饰品、正负特质、疾病，以及首次/最后观测 revision；
- 远征流水：地点、房间、遭遇、伤害、压力、状态、消耗品、战利品、死亡、撤退和结算；
- 动作记录：请求 ID、来源 revision、决策理由、机械步骤、语义结果和对账状态；
- 来源标记：实时内存/日志、显式存档核对或人工修正；
- 变更历史：采用追加事件生成当前快照，不原地覆盖唯一事实。

内存地址只能用于当前进程关联，长期英雄主键使用游戏的稳定 roster GUID。`inspect_state` 已把 `Actor+ACTOR_ID_OFF` 的 GUID 加入英雄档案流；旧版没有 GUID 的日志仍可解析，但不会被误写成长期英雄档案。

### 模型战略笔记

- 英雄定位和常用编队；
- 当前培养计划、治疗优先级和资源预算；
- 对敌人与区域的风险判断；
- 关键决策理由、失误与待验证假设；
- 下一次游戏需要继续执行的计划。

这些笔记由模型编写，但通过中间层保存为带时间、远征 ID、相关英雄 ID 和证据 revision 的 `reflection`。模型不另外维护一份无法与事实对账的自由文本数据库。

## 读取策略

- 开档或恢复会话：读取当前英雄快照、最近一次远征摘要和未完成计划；
- 选择队伍/治疗/升级：按需展开相关英雄完整历史；
- 战斗中：只读取当前战术包，不注入整段生涯记录；
- 远征结束：中间层生成事实简报，模型追加战略复盘和后续计划。

## 建议存储

使用本地 SQLite 保存实体、快照和追加事件；长文本简报可同时导出 Markdown 供人查看。SQLite 是事实源，Markdown 是可读视图。

活动数据库默认位于 `%LOCALAPPDATA%\DD1AgentBridge\campaigns\<campaignId>\campaign.sqlite`，避免 SQLite 的 WAL 文件与坚果云同步互相干扰；可用 `DD1_MEMORY_DB` 覆盖。需要人工查看或备份时，调用导出接口把 `campaign.md`、`heroes.md` 和 `expeditions.md` 原子写入项目目录。

## 已实现接口

- `get_campaign_resume`：读取跨进程续玩概览，只包含英雄索引、疾病名称、近期已核验决策、远征摘要和当前计划；
- `get_hero_memory`：按稳定 GUID 展开一名英雄的完整当前档案、变化历史和相关复盘；
- `record_reflection`：保存 `expedition_review`、`hero_plan`、`lesson` 或 `campaign_plan`；
- `export_campaign_journal`：导出可读 Markdown；
- 实机长连接另提供 `resume`、`hero_memory`、`reflect`、`memory_status` 和 `export_memory` 操作。

中间层只在英雄资料变化时追加 `hero_observations`，并保存有战术结果、增益、任务变化或新基线的节点。普通轮询不会无限复制同一状态。动作仍以 `success|failure|uncertain` 的语义核验结果入库，不能用 `queued` 或 `accepted=1` 代替。

启动或任务恢复只调用一次概览；普通战斗不读长期档案。只有编队、治疗、升级或复盘涉及特定英雄时才调用 `get_hero_memory`，因此数据库增长不会线性增加每回合上下文。
