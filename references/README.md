# 参考项目清单

这些仓库用于审阅协议、解析和运行时控制方式。它们保持为彼此独立的 Git 仓库，不把第三方源码直接复制进本项目。

| 项目 | 本地目录 | 当前提交 | 许可证/状态 | 用途 |
|---|---|---|---|---|
| Blindest Dungeon | `Blindest-Dungeon` | `8b2d11bb48067957a7b1f48dfbe62bf76142e0f4` | v0.10 声明正式开源并允许检查和任意修改；根 MIT 不覆盖该部分 | 运行时内存、UI 语义、SDL 输入与事件 |
| darkest-dungeon-mcp | `darkest-dungeon-mcp` | `4eea9d6a0e875a7095e130e44adbecce6ad33b68` | 源码 ISC；部分知识数据 CC BY-NC-SA 4.0 | MCP、状态标准化、游戏定义与本地化 |
| DarkestDungeonSaveEditor | `DarkestDungeonSaveEditor` | `13fa97a28b9f405a85d93ba05fc9bad269b3c7da` | MIT | DSON 存档格式和解码器 |
| DarkestDungeonBot | `DarkestDungeonBot` | `0093986c5c0fbba9da26f6c65456d11b418ec77d` | MIT | 存档轮询、输入控制和失败案例 |

## DDSaveEditor 运行包

- 发布版：`v0.0.70`
- JAR 位置：`darkest-dungeon-mcp/tools/DDSaveEditor.jar`，该文件由上游 `.gitignore` 排除；
- SHA256：`FD7A052F5DA21FDE991893BC3D5AE9B03DBC59A9002B206388C3396199E10B90`；
- Java：使用 Mathematica 自带的 64 位 Java 8；
- 中文路径兼容：通过 `../scripts/prepare_decoder.ps1` 制作纯 ASCII 临时运行副本。

## 使用边界

- v0.10 release 已明确项目正式开源，并允许任何人检查或以任何方式修改代码，因此本地修改、构建和集成无需再等待授权；
- 2026-09-26 再次核查当前上游 `main`：仓库根目录仍没有项目本体的 `LICENSE` 或 SPDX 标识，release 也没有明确修改版源码和 DLL 的再发布条件；公开仓库暂不纳入上游源码、修改版 DLL 或含派生源码的补丁，详细证据见 [`docs/licensing/001-third-party-source-audit.md`](../docs/licensing/001-third-party-source-audit.md)；
- `darkest-dungeon-mcp/data/knowledge` 中的非商业、相同方式共享条款与 ISC 源码条款分开处理；
- 本项目第一版不采用参考 Bot 的硬编码战斗策略。
