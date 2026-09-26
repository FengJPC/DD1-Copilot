# 后台定向输入修复

日期：2026-09-25

## 现象

命名管道返回 `queued`，DLL 日志也记录 `accepted=1`，但 Darkest Dungeon 不在前台时：

- `Shift+D` 分格行走会进入 `tilestep`，随后因队伍没有移动而超时；
- 战斗数字键可以进入合成 SDL 队列，却没有让游戏武装对应技能；
- 将游戏窗口切回前台后，相同链路立即恢复。

这证明传输和游戏主线程调度正常，失败位于游戏自己的输入判定。

## 根因

当前 Steam 构建中，游戏按键处理函数会把 SDL `KEYDOWN` 写入内部按键状态表；但随后查询“按键是否按下”的函数先调用输入门检查。该检查首先读取 `MOUSE_INWINDOW_RVA`。当游戏失去焦点时，这个字节为 0，即使内部按键状态已写为“刚按下”或“按住”，查询仍返回未按下。

鼠标合成路径此前已经在发送事件前把同一个门设为 1，键盘合成路径没有做这一步。

## 修改

1. 在 `input/synth.cpp` 新增 `prepareSynthKeyInput`，合成键盘事件前打开游戏内部 `in-window` 门。
2. `serviceTileStep` 在 DLL 持有 A/D 的整个期间维护该门，使连续移动不依赖 Windows 前台窗口。
3. Copilot 的战斗技能和扎营技能直接点击 `inspect_state` 给出的技能元素，不再把数字键作为选择技能的必要路径。
4. 保留现有状态与日志结算：输入门修复不把 `queued` 或 `accepted=1` 当作动作成功。

## 本地验证

- `npm test`：23/23 通过；
- `npm run typecheck`：通过；
- `npm run build`：通过；
- MSVC `build.ps1 -NoDeploy`：成功；
- 生成的 DLL：2,087,936 字节，SHA-256 `228BE25E11EFD3E25E0A82A39D5F4960A58C6A023956F9919464C959C2D31362`。
- 已部署到 `E:\SteamLibrary\steamapps\common\DarkestDungeon\_windows\win64\ddaccess.dll`，部署后哈希一致；旧 DLL 已备份到 `backups/pre-background-input-deploy-20260925-191855/`。

## 待实机验收

启动测试存档后，让 Codex 保持前台，分别核对：

1. 走廊连续前进会移动并在物件、陷阱、门或战斗处停止；
2. 战斗技能会在后台完成武装、选目标和结算；
3. 游戏不会抢回 Windows 前台，也不会接收用户在 Codex 中文输入框里的文本。

## 首轮实机结果与第二次修复

首轮实机验证确认：当 `MOUSE_INWINDOW_RVA` 已经为 1 时，技能元素点击、目标键和确认键都能在游戏后台完成语义结算，Windows 前台保持在 Codex。

友方治疗测试又暴露两个独立边界：

1. `skill_armed` 会先于首个 `target_preview` 出现。旧 Copilot 在前者出现后立即发送方向键，目标列表可能尚未初始化。现在选择步骤必须同时看到本次技能武装和首个目标预览。
2. 当游戏在后台把 `MOUSE_INWINDOW_RVA` 重置为 0 时，仅在返回第一条合成鼠标事件时打开门仍然太晚。日志显示 `fe-click` 与 `accepted=1` 均存在，但没有 `skill_armed`；游戏已经丢弃首个悬停，因此按钮没有进入可点击状态。

第二次 DLL 修改把鼠标门准备移动到 `moveCursorTo` 之前，并在队列未清空时持续维护。DLL 已编译并部署：2,087,936 字节，SHA-256 `CB88E6465C3854A96F920172FB5E74DBA5912D2811383E78F5089CB5327C7199`。部署前版本保存在 `backups/pre-background-mouse-gate-deploy-20260925-1945/`，需重启游戏后复验。
