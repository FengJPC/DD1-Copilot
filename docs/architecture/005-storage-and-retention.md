# 四类记录与存档绑定

日期：2026-10-02

## 保存边界

| 类别 | 内容 | 生命周期 |
| --- | --- | --- |
| 游戏存档 | 游戏自己维护的进度、人物与资源 | 原位置由游戏维护；核对时才显式解码 |
| 中间层事实 | 英雄资料及变化、已核对动作与必要证据、阶段与钱包检查点、远征事实摘要 | 每个存档一个本地 SQLite，长期保存 |
| AI 复盘 | 模型显式提交的理由、远征复盘、英雄计划与经验 | 与事实共用 SQLite 的独立表；正文导出至 `reflections.md` |
| 临时遥测 | DLL 原始日志、内存探测、输入跟踪、近期读取缓存、存档解码中间文件 | DLL 当前日志约超过 64 MiB 清空重写；读取缓存最近 2,000 行；解码副本在调用结束清理 |

游戏安装目录的 `ddaccess-debug.log` 是临时传输通道。Game MCP 仍保留近期原始记录供核对；长期动作记录保存筛选后的证据、命令关联与抑制/遗漏计数，单个证据数组最多 128 项，不复制整段诊断洪流。长期记录不包含模型未提交的聊天内容或自动生成的战略判断。

## 固定绑定

在仓库根目录设置忽略提交的 `memory.local.json`：

```json
{
  "campaignId": "my-test-campaign",
  "saveDirectory": "C:\\path\\to\\Steam\\userdata\\account\\262060\\remote\\profile_2"
}
```

环境变量 `DD1_SAVE_DIR`、`DD1_CAMPAIGN_ID`、`DD1_MEMORY_DB` 显式配置时优先于项目配置；`DD1_MEMORY_CONFIG` 可指定另一个配置文件。只配置存档目录时，首次按完整规范路径的哈希生成 ID；同名 profile 位于不同账号/目录时不会共用数据库。已注册的存档总是沿用原 ID 与数据库。

活动数据库默认位于 `%LOCALAPPDATA%\DD1AgentBridge\campaigns\<campaignId>\campaign.sqlite`，一一绑定登记在 `%LOCALAPPDATA%\DD1AgentBridge\storage-bindings.json`。数据库本身也记录规范存档目录；拒绝切换到另一个存档、另一个战役或另一个临时数据库。未配置时不再回退到 `local-default`。没有实际存档的隔离测试可以显式指定独立 `DD1_CAMPAIGN_ID`。

当前绑定来自启动配置，DLL 尚未提供经过核验的存档身份接口，因此不能自动识别用户在同一游戏进程中切换的存档。切换存档时停止 Copilot，改用该存档配置，再重新启动；更换槽位中的整份存档时也需要新战役 ID/数据库，先归档旧绑定。这项边界不能由人物姓名或相同 GUID 推断。

## 人物与远征维护

`CopilotSession` 在返回 compact、delta、full 之前，使用同一次观察的内部完整状态维护事实；事实维护不依赖模型投影是否显示人物详情。动作结算后同样观察最新日志状态。准备名单保存 GUID、职业、等级、生命/压力文字、武器/护甲、怪癖、疾病和已知饰品；建筑选中英雄保存已知职业、等级、经验与训练选项；地下城保存按稳定 roster GUID 关联的已知属性、生命/压力、抗性及行动栏技能。没有 GUID 的招募地址和斗技场运行时角色不写入远征人物档案。

缺失字段保留原记录，并不解释为零、无疾病或未装备。完整人物读数中的明确空列表可以清除先前疾病/怪癖。普通重复观察只更新最近观察时间；资料 A→B→A 会保存三个连续历史版本。历史资料可能包含观察时的增益，需要最新运行状态核对。

loading、孤立的 results、斗技场不创建远征。进入可确认的地下城阶段建立记录，收集任务和结算资料；观察到回城后关闭远征。`complete` 表示记录已收尾，不等于任务胜利；只有实际观察到任务目标完成才标记 `objective_complete_observed`，否则为 `unknown`。

返回城镇后的 `advisories.review_expedition` 指向最近未复盘远征及事实摘要；`resume` 可查最近三条待复盘项。`record_reflection`/`reflect` 支持显式 `expeditionId`，拒绝其他战役或仍 active 的远征。省略 ID 时，远征复盘关联最近已完成、未复盘的记录，而不是当前正在进行的远征。中间层提供简报，模型负责写复盘；已有历史不会因此被自动伪造为已复盘。

## 导出与旧库整理

SQLite 是长期记录的主存储。导出文件为 `campaign.md`、`heroes.md`、`expeditions.md`、`reflections.md`，不再静默限制为最近 1,000 条。Markdown 是按需生成的视图，不是另一套需要同步写入的数据库。

`npm run memory:maintain -- --plan <plan.local.json>` 默认只读审计。计划包含 `archiveRoot`，以及每项的 `label`、`source`、`mode`（`bind` 或 `archive`）；绑定项必须明确存档目录及已存在的战役 ID。关闭游戏和 Copilot 后，用 `--apply --offline` 执行。

整理先使用 SQLite backup API 获得包含 WAL 的一致备份，并对每张表全部记录计算内容哈希。所有备份通过后才升级或归档原库；跨盘复制核验完整文件字节后才移除对应原文件，原始库及备份均保留于归档目录。归属不明的旧库标为 `archived_unassigned`，不会按相同名字/GUID 猜测合并。中断时读取 `manifest.json`，用同一计划加 `--resume <archive-directory>` 恢复。已完成的项先核验，再跳过。

Schema v2 保留原记录，增加存档绑定和远征结算字段，去掉英雄历史对全部旧 profile hash 的唯一约束。执行真实迁移前应完成备份；活动 SQLite 留在本地盘，归档和 Markdown 可另行备份。私有配置、数据库、归档、日志及游戏文件均不提交公开仓库。
