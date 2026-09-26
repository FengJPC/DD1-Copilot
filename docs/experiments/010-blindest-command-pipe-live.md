# 010：Blindest 命令管道实机部署

日期：2026-09-25

## 编译与部署

- Build Tools：`D:\VisualStudio\BuildTools2022`；
- 编译器：MSVC 19.44，C++17；
- 构建脚本已改为由 PowerShell 直接调用 `cl.exe`，支持中文检出路径；
- 游戏目录：`E:\SteamLibrary\steamapps\common\DarkestDungeon\_windows\win64`；
- 部署 DLL 大小：2,076,160 字节；
- 部署 DLL SHA256：`6F770FDC0A84D38C2549896E08671DDFF295E6A1AB5F490833A64E202465B008`。

原始 Blindest v0.10 DLL 已备份到：

```text
backups/blindest-ipc-predeploy-20260925-022143/ddaccess.dll
```

原始 SHA256：`EFC6C528EAC8050C6222A5DEEEBBEDAD892032DDC19241093B81E879E6CA1041`。

## 启动方式

`DarkestAccess.exe` 默认通过已运行的 Steam 启动游戏，Steam 不会继承临时设置的 `DD1_AGENT_PIPE`。新增：

```text
scripts/start_agent_game.ps1
```

脚本直接启动 `Darkest.exe`，使游戏继承命名管道环境，再运行 `DarkestAccess.exe` 完成 DLL 注入。环境变量只传给本次子进程，不写入用户或系统环境。

## 管道访问控制

管道使用显式 DACL：

1. 游戏进程的当前 Windows 用户拥有完全访问；
2. 可选的 `DD1_AGENT_CLIENT_SID` 只有读写权限；
3. 启动脚本会解析本机 `CodexSandboxUsers` 组 SID 并传给游戏；
4. 仍保留 `PIPE_REJECT_REMOTE_CLIENTS`。

`exec_command` 自身的外层隔离策略仍会阻止直接连接宿主管道；宿主用户进程的项目客户端连接正常。后续应通过 Codex 启动的正式 MCP 服务验证其实际运行令牌。

## 实机验证

游戏日志确认：

```text
agent-ipc: listening on \\.\pipe\dd1-agent-bridge
```

无动作协议探针返回：

```json
{"commandId":"safe-probe-001","status":"rejected","reason":"unsupported command kind"}
```

项目自己的 `NamedPipeCommandTransport` 返回：

```json
{
  "health": {"configured":true,"available":true,"transport":"named_pipe"},
  "ack": {"status":"queued","transport":"named_pipe"}
}
```

发送无效键码 `sym=0` 后，游戏主线程记录：

```text
agent-ipc: serviced key sym=0x0 mod=0x0 accepted=0
```

这证明请求已完成“客户端发送、游戏管道接收、队列入队、游戏主线程出队”全链路，且没有触发可见游戏操作。

## 首次可见操作

在城镇总览中通过同一传输客户端依次验证：

1. `D`（`sym=100`）返回 `queued`，游戏主线程记录 `accepted=1`，Blindest 反馈“区域已锁定”；
2. 右方向键（`sym=1073741903`）返回 `queued`，游戏主线程记录 `accepted=1`，但当前画面没有明显变化；
3. `C`（`sym=99`）返回 `queued`，游戏主线程记录 `accepted=1`，画面实际进入驿站马车并显示首次教程。

第三步通过窗口截图和新增建筑日志共同确认，证明有效按键可以经管道改变真实游戏界面。它没有招募英雄、花费资源或修改队伍。实验同时说明 `queued` 与 `accepted=1` 仍不足以推断具体界面结果，中间层必须继续核对日志或视觉状态。

## 回滚

关闭游戏后，将备份的 `ddaccess.dll` 复制回游戏 `win64` 目录即可恢复官方 Blindest v0.10 DLL。`DarkestAccess.exe` 与 `prism.dll` 在本次实验中没有修改。
