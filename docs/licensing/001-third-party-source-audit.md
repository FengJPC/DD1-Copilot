# 第三方源码许可审计

审计日期：2026-09-26

本记录说明 DD1 Copilot 依赖或参考的第三方项目、当前公开范围，以及补齐端到端复现所需的授权。它是工程发布边界记录，不是法律意见。

## 结论

DD1 Copilot 原创的 TypeScript MCP、中间层、测试、脚本和文档可以按根目录 MIT License 发布。当前不能把本地修改的 Blindest Dungeon 源码和 DLL 一并标成 MIT，也不应仅凭 v0.10 的“正式开源”说明推定其允许再发布。

这会造成一个实际限制：别人可以查看和运行 DD1 Copilot 的上层代码，但无法仅凭当前公开仓库从头构建完整的游戏侧桥接 DLL。完整复现需要上游作者补充标准许可证，或明确同意我们发布修改版源码和编译后的 DLL。

## Blindest Dungeon

- 上游：<https://github.com/Vicorin/Blindest-Dungeon>
- 本地修改基线：v0.10，commit `8b2d11bb48067957a7b1f48dfbe62bf76142e0f4`
- 2026-09-26 在线复核的 `main` tree：`87abec3a761b5a28e84a42bff24f00d3b703eaf6`
- 发布声明：<https://github.com/Vicorin/Blindest-Dungeon/releases/tag/v0.10>

v0.10 发布说明允许任何人检查或以任何方式修改源码。这足以支撑我们当前的本地研究、修改和构建。在线主分支根目录只有 README、Source、安装器和发布包；GitHub 仓库元数据没有识别到项目许可证，递归树中也没有覆盖 Blindest Dungeon 自身代码的根 LICENSE、COPYING 或 SPDX 声明。

缺少的是以下明确授权：

- 复制并公开发布修改后的源码；
- 公开发布由修改源码编译出的 DLL；
- 将这部分代码再许可为 MIT 或其他许可证；
- 需要保留哪些署名、通知、源码提供方式或相同许可条件。

GitHub 的许可说明也区分了公开可见与获得开源许可：没有许可证时默认版权规则仍然适用，公开仓库的 GitHub 条款主要允许查看和 fork，并不自动提供一般性的复制、再发布和派生作品许可：<https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository>

因此当前采取以下边界：

1. 根 MIT 不覆盖 Blindest Dungeon 或我们的派生修改。
2. 不提交上游源码、修改后的 DLL、安装器或包含派生源码片段的补丁。
3. 允许本地持有上游源码的维护者构建和测试。
4. 取得明确授权后，把修改放入独立 fork，保留上游提交历史、作者信息及全部第三方通知；DD1 Copilot 主仓通过文档、构建脚本或固定 commit 指向该 fork。

独立 fork 比把第三方源码直接拷入主仓更清晰：上游代码的许可和历史保持独立，Copilot 自己的 MIT 范围也不会被误读。

## 建议向上游确认的最小问题

若上游不准备立即选择标准许可证，至少需要其公开确认：

> May we publish and redistribute our modified Blindest Dungeon source code and compiled DLLs, with attribution to you and preservation of all bundled third-party license notices? If so, may we maintain those changes in a public GitHub fork?

更理想的处理是由上游在仓库根目录加入 MIT、BSD-2-Clause、BSD-3-Clause、Apache-2.0、MPL-2.0 等明确许可证。具体许可证应由上游作者选择，我们不代替作者决定。

## Blindest 所带 Prism

`Source/Mod/lib/prism/NOTICE` 将 Prism 自身标为 MPL-2.0。其 `LICENSES` 目录还分别保留：

| 组件 | 已记录许可证 |
|---|---|
| Prism | MPL-2.0 |
| simdutf | Apache-2.0 |
| Moderncom | MIT |
| dr_wav | public domain 选项 |
| Djinni support library | Apache-2.0 |
| concurrentqueue | Simplified BSD |
| {fmt} | MIT |

这些许可证解决各自组件的使用和再发布问题，但不能反向覆盖 Blindest Dungeon 自己编写的源文件。未来发布 fork 或 DLL 时应保留 Prism 的 `NOTICE` 和完整 `LICENSES` 目录，并根据 MPL-2.0 保留相应源码文件的许可状态。

## 其他参考项目

| 项目 | 状态 | 当前使用方式 | 发布影响 |
|---|---|---|---|
| Darkest Dungeon Save Editor | MIT | 可选的外部 JAR；本仓不分发 | 保留来源说明即可；若以后打包 JAR，随包保留 MIT 文本和署名 |
| DarkestDungeonBot | MIT | 仅作设计参考；未复制源码 | 当前无打包义务，保留来源说明 |
| darkest-dungeon-mcp | 源码 ISC；知识数据 CC BY-NC-SA 4.0 | 仅作接口和架构参考；知识 JSON 未采用 | 不把其知识数据混入 MIT 发布物；若以后采用，需单独署名、非商业和相同方式共享 |

本次检查没有发现上述三个参考源码树或其二进制被 Git 跟踪。公开仓库只保留 `references/README.md` 的来源记录。

## npm 依赖

项目通过 `package.json` 和锁文件声明依赖，并未把 `node_modules` 提交到仓库：

| 包 | 已安装版本 | 许可证 |
|---|---:|---|
| `@modelcontextprotocol/server` | 2.1.0 | MIT |
| `zod` | 4.6.5 | MIT |
| `@types/node` | 24.13.6 | MIT |
| `tsx` | 4.23.15 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |

源码仓发布可以继续使用根 MIT；npm 安装得到的依赖仍分别服从其原许可证。若以后制作包含 `node_modules` 的离线安装包，应将对应许可证文本和必要通知一并收集到发布物中。

## 发布检查表

- [x] 根 MIT 明确只覆盖 DD1 Copilot 原创部分。
- [x] `THIRD_PARTY_NOTICES.md` 列出直接依赖、参考项目和 Blindest/Prism 边界。
- [x] `.gitignore` 排除第三方源码树、DLL、EXE、JAR、实机日志和存档。
- [x] 当前 Git 跟踪文件中未发现第三方源码或二进制。
- [ ] 上游增加标准许可证，或明确授权再发布修改源码与 DLL。
- [ ] 获得授权后创建独立 fork，并在 fork 中保留上游历史、署名、Prism NOTICE 和 LICENSES。
- [ ] 为每个 DLL 发布记录对应源码 commit、构建方法和 SHA-256。
