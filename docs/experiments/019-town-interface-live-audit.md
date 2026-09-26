# 019 城镇接口实机审计

## 目标

在不消耗资源、不招募和不改变英雄状态的前提下，检查城镇地点的进入、结构化读取、关闭与校验路径。

## 实机结果

| 界面 | 读取结果 | 当前可执行动作 |
| --- | --- | --- |
| 驿站马车 | 界面与候选人状态可识别；本周无可招募英雄 | 关闭；有候选人时已有招募动作 |
| 公会 | 6 名英雄 GUID；选中英雄后可读技能树 | 关闭 |
| 铁匠铺 | 6 名英雄 GUID；Reynauld 的武器/护甲步骤、价格和元素 ID 完整 | 关闭 |
| 酒馆 | `bar/gambling/brothel` 各 3 格，锁定、占用和收费状态完整 | 关闭 |
| 教堂 | `meditation/prayer/flagellation` 各 3 格，锁定、占用和收费状态完整 | 关闭 |
| 游牧民货车 | 2 件商品的 ID、名称、价格、效果、稀有度和职业限制完整 | 关闭 |
| 墓园 | `memorialCount=0` 与空列表一致 | 关闭 |
| 先祖回忆录 | 建筑状态可读，当前无已解锁条目 | 关闭 |
| 疗养院/生存大师 | 地点明细标记为未解锁 | 在中间层校验阶段拒绝，未发送输入 |

## 发现的问题

1. 从远征准备返回时会短暂进入 `none` 上下文。中间层原先在这里清空地点名册，而 DLL 每个游戏会话只输出一次名册，导致 `locationCount=12` 但 `locations=[]`。
2. 建筑打开动作已经语义核对成功，但日志显示仍由 `click_element -> fe-click` 执行；关闭建筑则由 Escape 进入 SDL 兜底。
3. 建筑刚打开时，普通状态查询只有界面类型。额外发送 `inspect_state` 后才有钱包、活动、商品和升级树。
4. 中间层动作 schema 对城镇只有打开、马车招募和关闭；只读信息已经足够，但还无法用稳定 ID 执行大部分经营。

## 本轮修复

- `none` 不再触发全量会话清空；`title/loading` 仍是存档隔离边界。
- 打开建筑成功后自动做一次只读检查。
- 增加 `activate_element` 原语，城镇入口和返回按钮改用原生回调。新 DLL 部署后，公会入口记录为 `fe-activate ... rva=0x6db510`，返回按钮记录为 `fe-activate ... rva=0x663cc0`；两次操作都完成语义结算，且无 `fe-click` 或 SDL 键兜底。

## 后续接口

下一组语义动作应以稳定 ID 为参数，并在返回前完成只读对账：

- `select_building_hero { heroGuid }`
- `assign_town_activity { activityId, slot, heroGuid }`
- `cancel_town_activity { activityId, slot }`
- `buy_hero_upgrade { heroGuid, optionId, stepCode }`
- `buy_town_item { itemId }`
- `buy_building_upgrade { trackId, stepCode }`

成功条件分别以选中 GUID、活动格的 committed GUID、钱包与升级等级变化、商品移除与背包增加、升级轨道的 bought/next 变化为准。

## 2026-09-26 集中实现

上述六组接口已经实现，并增加 `open_building_upgrades` 用于先进入建筑升级页。DLL 直接解析当前界面中的稳定身份并调用游戏内部回调；Copilot 在动作后强制刷新建筑快照并按上面的状态变化结算。

普通减压活动支持 `activityId + slot + heroGuid` 一次完成。疗养院的槽位还要求明确病症或怪癖及锁定/移除方式，当前统一分配接口会拒绝这种槽位，待补充专门的治疗动作后再开放。

静态验证结果：TypeScript 构建、83/83 测试和原生 DLL 构建通过。部署 DLL 共 2,126,848 字节，SHA-256 为 `DA095500FCF3347A79E4D4FF2399FC5AF281837B31193AEDB0ECF1FF78B335DE`。新接口尚未进行游戏内资源操作验收，因此实际购买与安排活动仍应先在测试存档小额验证。
