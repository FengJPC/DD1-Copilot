# Codex 本地插件

## 结构和分发边界

`plugins/dd1-copilot/` 是插件模板。提供 portable `plugin.json`/`mcp.json`、当前 Codex 兼容的 `.codex-plugin/plugin.json`/`.mcp.json` 和一项 `play-darkest-dungeon` 技能。技能定义状态、动作核对、解说和复盘的使用流程，战略决策仍由模型完成。

`npm run plugin:package` 在新的临时目录编译运行时，按 lockfile 复制生产依赖，并生成带内容哈希的 `package-contents.json`；成功后替换 `build/dd1-copilot`。它只复制指定模板、项目许可证和声明、编译代码与生产依赖，不打包源码工作目录、开发依赖、DLL、游戏文件、私有配置、存档或数据库。生产依赖保留各自原始许可证，不能统一声明为项目 MIT。Windows 文件短暂占用允许有限重试，失败保留错误并停止。

`.agents/plugins/marketplace.json` 的 `dd1-local` 指向构建产物，供本机 Codex 安装缓存副本。更新需要重新打包并重新安装；仅修改源码不会更新已安装插件。源目录和安装缓存都不承担记录存储。此路径用于本地安装，不是官方目录公开上架或自动下载成品包。

## 设置与安装

前提是 Windows、PATH 中可用的 Node.js 24+ 和已单独部署的匹配 DLL。先安装 npm 依赖：

```powershell
npm ci
npm run plugin:package
# 已有 launcher.local.json 和 memory.local.json 时：
.\scripts\configure-plugin.ps1 -FromProject -CheckOnly
.\scripts\configure-plugin.ps1 -FromProject
.\scripts\install-plugin.ps1
```

首次安装到另一台电脑可显式传入绝对目录：

```powershell
.\scripts\configure-plugin.ps1 -GameDirectory 'E:\SteamLibrary\steamapps\common\DarkestDungeon\_windows\win64' -SaveDirectory 'C:\path\to\remote\profile_2' -CampaignId 'my-campaign'
```

`CheckOnly` 只预览验证，不写持久配置。应用配置前检查存档登记冲突；已有配置改写前备份。安装脚本调用宿主 `codex plugin marketplace add` 和 `codex plugin add`，不手写覆盖其他插件设置。Codex 工具列表需要刷新，必要时重启应用并进入新聊天。游戏使用 `start_dd1_agent.cmd` 启动以继承命名管道设置和禁用朗读。

## 私有配置和存档

默认设置位于 `%LOCALAPPDATA%/DD1AgentBridge/copilot-plugin.local.json`：

```json
{
  "logPath": "C:\\path\\to\\DarkestDungeon\\_windows\\win64\\ddaccess-debug.log",
  "commandPipe": "\\\\.\\pipe\\dd1-agent-bridge",
  "campaignId": "my-campaign",
  "saveDirectory": "C:\\path\\to\\remote\\profile_2"
}
```

`databasePath` 可选；已有登记继续沿用原数据库。`DD1_PLUGIN_CONFIG` 可以显式选择另一配置文件，文件不存在时失败；日志和命令管道允许相应环境变量覆盖。显式 memory 环境变量作为一组覆盖配置，沿用原存储层规则。正常插件模式必须有实际存档目录，单独 campaign ID 的测试模式不能启动插件。卸载或更新插件不会删除这些设置和档案。

存档绑定来自启动配置；DLL 仍没有经验证的运行中存档身份接口。同一游戏进程切换存档后，必须更换配置并重启 Copilot。配置检查不会创建新数据库或改写登记。

## 启动与核对

插件引导脚本直接在同一 Node 进程导入已有 MCP stdio 入口。stdout 保持纯 JSON-RPC；错误和诊断送到 stderr。MCP 初始化和工具发现不占用游戏控制权；首次发送游戏指令时取得会话独占，EOF/信号关闭时释放。其他会话在输入发送前收到明确拒绝，独立 JSON helper 与插件不能同时控制同一管道。原有数据库释放与请求去重逻辑继续生效。

`node build/dd1-copilot/scripts/server.mjs --check` 只验证 Node、运行时、配置和绑定，报告日志/数据库是否存在，不连接游戏、不发送指令、不打开数据库。真实连接能力须在 `get_state`/`refresh_state` 中核对。游戏操作依旧由 `act` 完成，并等待语义证据及下一次决策；工具 timeout 为 90 秒，以容纳最多 60 秒的交接等待和动作核对。

跨目录协议回归会把整个包搬到含中文和空格的临时路径，建立隔离存档/数据库和日志，通过真实 MCP 初始化、发现九个工具、读取状态/战役概览、EOF 关闭和立即重启。它验证打包运行与资源释放，不替代下一次 DLL/游戏实测。

官方规范参考：[插件包装和本地市场](https://developers.openai.com/plugins/build/plugins)。
