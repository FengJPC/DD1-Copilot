# 2026-10-03：Codex 本地插件打包与安装

## 验收

- 插件 ID 为 `dd1-copilot@dd1-local`，版本 0.2.1；Codex 本机 `plugin add` 成功，`plugin list --marketplace dd1-local --json` 确认 installed/enabled 均为 true。使用官方本地市场规范及宿主命令完成注册安装。
- 当前包共 1,040 个内容文件、14,427,737 字节（未计清单自身）；生产依赖为 `@modelcontextprotocol/core` 2.1.0、`@modelcontextprotocol/server` 2.1.0、`zod` 4.6.5。包内保留原始许可证，MCP 包的 license 文字描述许可转换，不能只采用 npm 元数据 MIT 标签。
- 将完整包复制到含中文/空格的临时目录，使用独立存档与 LOCALAPPDATA，通过真实 stdio JSON-RPC 初始化、发现九项工具、读取 compact 状态及战役概览。输入 EOF 后 exit 0，并成功立即重启。
- `--check` 在全新隔离配置中不创建数据库或登记文件。本机安装缓存的相同检查成功，继续使用既有 profile_2 登记，日志和数据库均存在。没有通过该检查声称已连接游戏。
- 本机私有设置保存于 `%LOCALAPPDATA%/DD1AgentBridge/copilot-plugin.local.json`，没有将设置、数据库、DLL 或原始日志复制进插件。未修改游戏/DLL，也没有执行游戏动作。
- 插件技能验证通过；两个 PowerShell 脚本解析检查通过；128 项完整回归、TypeScript 构建、未使用符号检查和 diff 空白检查通过。

首次打包出现 Windows EPERM 目录短暂占用，增加限定输出路径内的有限重试后通过。首次并行测试有一个共享辅助文件读取 EBUSY；完整顺序执行后 128/128 通过，没有把文件加载失败视为业务断言通过。

## 2026-10-06：0.2.2 多聊天启动修复

- 在 Codex 启动日志及真实初始化中复现 `A DD1 Copilot process already owns this game command pipe`。旧版在启动时取得会话独占，使其他聊天和工具发现进程在 MCP 握手前退出。
- 将 MCP 的独占检查移到首次发送游戏指令时；初始化和工具发现允许并存，争用输入在发送前拒绝。会话关闭时释放控制权，JSON live helper 的启动独占保持有效。
- 129/129 完整顺序回归、TypeScript 检查通过，包含多进程发现、控制权拒绝及关闭后接管。通过 Codex `mcpServerStatus/list` 实际发现安装版 0.2.2 的全部九项工具，`toolsError` 为空。
- 同版本覆盖缓存失败后，按新版本目录安装 0.2.2；核对管道所属 PID 和 Codex 父进程后关闭旧控制进程。没有更新 DLL，也没有执行游戏动作。

## 下一步

已通过宿主工具发现；刷新/重启 Codex 后，在绑定存档中核对游戏连接、城镇准备与完整远征。协议回归使用隔离日志和数据库，不代替真实 DLL 操作验收。当前本地市场指向构建产物，需要先打包再安装；未发布到公共插件目录。
