# 007：完整战斗鼠标闭环

日期：2026-09-25

## 目标

验证在《Darkest Dungeon 1》实战中，Codex 能否依靠画面与 Blindest Dungeon 日志完成“读取状态 → 决策 → 鼠标执行 → 校验结果”的完整战斗闭环。

## 场景

- 地点：老路任务末段
- 我方：Reynauld、Dismas
- 敌方：Brigand Bloodletter（35 HP）、Brigand Fusilier（12 HP）
- 控制方式：Computer Use 鼠标点击
- 状态来源：实时画面与 `ddaccess-debug.log`

## 战斗过程

1. Dismas 使用 Pistol Shot 攻击后排 Fusilier，造成 7 点伤害。
2. Reynauld 对 Bloodletter 尝试 Stunning Blow；日志与随后敌方行动表明这次控制没有阻止其行动。
3. 第二轮 Dismas 再次使用 Pistol Shot，击杀 Fusilier。
4. Reynauld 使用 Smite，重创 Bloodletter。
5. Dismas 使用 Open Vein，造成伤害并施加流血。
6. Reynauld 再次使用 Smite，将 Bloodletter 压至低生命。
7. 第四轮 Dismas 使用 Open Vein 完成击杀。

每一步均执行了技能选择和目标选择，并在动作后通过新画面及日志确认伤害、目标、回合切换和死亡状态。

## 任务结果

- 战斗胜利并触发任务完成。
- 使用 Take All 收取全部战利品。
- 任务奖励：5,000 金币。
- 结算页显示收集财宝：1,535。
- Reynauld 与 Dismas 各获得 2 点决心经验并升至 1 级。
- 已继续通过结算和教程弹窗，返回城镇主界面。
- 返回城镇后可见金币：8,675；英雄名册：2/10。

## 已验证能力

- 鼠标选择技能。
- 鼠标选择合法目标。
- 用日志确认技能已装备、目标列表、命中、伤害与回合推进。
- 处理尸体教程、战利品界面、任务结算和城镇教程弹窗。
- 在多轮战斗中根据敌方生命、站位与持续伤害调整后续选择。

## 当前边界

- 离散鼠标点击能够可靠进入游戏的 SDL 输入链路。
- Computer Use 的合成键盘事件目前仍不能可靠进入 SDL；切换为英文键盘布局没有解决这个问题。
- 玩家实体键盘的 A/D 失效来自中文输入法，切换到英文输入法即可恢复。
- 探索移动需要持续按键或持续鼠标按住，当前鼠标点击接口不适合长距离移动，因此暂时由玩家负责探索移动。

## 下一步

把这次可行性验证整理成最小战斗动作接口：

- `select_skill(hero, skill)`
- `select_target(target)`
- `read_combat_state()`
- `verify_action_result()`

接口先以鼠标执行、日志校验为实现，再逐步接入 Blindest Dungeon 的结构化动作能力。
