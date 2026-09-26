# 原生 FocusElement 激活定位

日期：2026-09-26

## 目标

把远征任务选择从鼠标定位与 SDL 点击改为游戏内部回调，同时保留任务索引变化作为语义验收条件。

## 实机证据

- 当前进程：Steam `Darkest.exe`，PID 31860，模块基址 `0x7ff66f5d0000`。
- 焦点元素向量中，任务标记 ID `0x717374 + questIndex` 与闭包参数逐一吻合。例如 `0x717378` 的 `callback_index=4`，其余可见标记也分别得到 0、1、2、3、5、6。
- 标记记录 `+0x30` 是主回调闭包；其虚表 `+0x10` 指向 `Darkest.exe+0x694090`。
- `Darkest.exe+0x694090` 将 `this` 调整到闭包数据并跳转至 `Darkest.exe+0x6935E0`。
- `Darkest.exe+0x6935E0` 从闭包首字段读取任务索引，写入 Campaign `+0x1248`，然后执行任务详情和界面更新逻辑。

以上读取与反汇编均未写进程内存。此前通过旧路径选择任务 4 后，Campaign 的已选索引由现有状态采集确认变为 4。

## 实现

- 新增 `frontEndActivateElementId(id)`：按 ID 获取当前 `FocusElement`，从运行时虚表读取主回调并在游戏主线程直接调用。
- 对虚表和函数地址做当前映像范围校验，并用 SEH 捕获异常。
- 远征任务选择改用该原生激活入口；现有 `g_embSelWatchUntil` 继续等待 Campaign 已选索引变化，不把“函数返回”当作成功。
- 当前仅把已逆向确认的任务标记切到该入口。其他控件逐项确认闭包语义后再迁移。

## 构建与待验收

- 原生构建通过；`ddaccess.dll` 2,120,192 字节。
- SHA-256：`7BD9A8611B3723D2C9D03B1E4A828ADBC1BF12A025A86B9EB49125F13B6B0D67`。
- 已在游戏进程完全退出后部署；源文件与游戏目录哈希一致。
- 上一版 DLL 已备份到 `backups/pre-id-abstraction-20260926-183726/ddaccess.dll`，部署清单位于同目录的 `deployment.json`。
- 冷启动后已验证：任务 1 切换到任务 4 的 Copilot 事务用时 232 ms。
- 游戏日志出现 `fe-activate id=0x717378 via native callback rva=0x694090`，紧接着出现 `embark: selection observed -> 4`；同一请求没有 `fe-click` 或 SDL 鼠标事件。
- 后续 `inspect_state` 读取 `sel=4`，任务详情和准备名单同步刷新。该路径的传输、原生执行和语义结果三层均已确认。
