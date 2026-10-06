# Third-party notices

The root `LICENSE` applies only to the original DD1 Copilot code,
documentation, tests, scripts, and future Codex plugin files maintained in this
repository. It does not relicense third-party projects, game files, binaries,
data, trademarks, or other assets.

## Blindest Dungeon

- Upstream: <https://github.com/Vicorin/Blindest-Dungeon>
- Reference version: v0.10, commit `8b2d11bb48067957a7b1f48dfbe62bf76142e0f4`
- Upstream statement: the v0.10 release declares the mod officially open
  source and permits anyone to inspect or modify the code in any way:
  <https://github.com/Vicorin/Blindest-Dungeon/releases/tag/v0.10>

Blindest Dungeon and modifications derived from it are separate from the
MIT-licensed DD1 Copilot code. Upstream has not specified a standard
project-wide license. A 2026-09-26 check of the current upstream `main` tree
also found no root `LICENSE`, `COPYING`, SPDX declaration, or explicit grant to
redistribute modified source or compiled binaries. The v0.10 statement is
treated as permission to inspect, modify, and build locally; it is not treated
as permission to publish our derived source or DLL under this repository's MIT
license.

The public repository therefore excludes the upstream source tree, installers,
compiled DLLs, and patches containing derived upstream code. This means the
current public repository is not yet a self-contained end-to-end build. After
the upstream author adds a standard license or gives explicit redistribution
permission, the intended publication form is a separate fork that preserves
upstream history, attribution, and applicable notices. Full evidence and the
release plan are recorded in
[`docs/licensing/001-third-party-source-audit.md`](docs/licensing/001-third-party-source-audit.md).

### Prism speech library bundled by Blindest Dungeon

The Blindest Dungeon source tree includes Prism headers and notices under
`Source/Mod/lib/prism`. Prism identifies its own code as MPL-2.0 and records
separate notices for simdutf (Apache-2.0), Moderncom (MIT), dr_wav (public
domain option), Djinni (Apache-2.0), concurrentqueue (simplified BSD), and
{fmt} (MIT). These notices cover those components only and do not supply a
license for Blindest Dungeon's own code. Any future distribution of the
modified Blindest component must preserve the relevant Prism `NOTICE` and
`LICENSES` material.

## Darkest Dungeon Save Editor

- Upstream: <https://github.com/robojumper/DarkestDungeonSaveEditor>
- License: MIT, copyright (c) 2018 robojumper

The editor and its JAR are not distributed by this repository.

## DarkestDungeonBot

- Upstream: <https://github.com/kgleken/DarkestDungeonBot>
- License: MIT, copyright (c) 2020 kgleken

This project was used as a design reference. Its source is not distributed by
this repository.

## darkest-dungeon-mcp

- Reference commit: `4eea9d6a0e875a7095e130e44adbecce6ad33b68`
- Original source, tests, configuration, and documentation: ISC, copyright (c)
  2026 darkest-dungeon-mcp contributors
- Wiki-derived knowledge data: CC BY-NC-SA 4.0

The wiki-derived knowledge JSON is not used or distributed by DD1 Copilot.
The reference repository remains outside the public repository.

## JavaScript build and runtime dependencies

The source repository declares, but does not vendor, these npm packages.
The generated local plugin package bundles the production dependency graph
selected by `package-lock.json`, currently `@modelcontextprotocol/server`,
`@modelcontextprotocol/core` and `zod`, with each package's original license
file, notices and README intact. Development tools are excluded from the plugin.

- `@modelcontextprotocol/server` and `@modelcontextprotocol/core`: npm metadata
  identifies MIT, but the installed 2.1.0 LICENSE describes an Apache-2.0/MIT
  transition and CC-BY-4.0 for documentation; the full bundled license controls
- `zod`: MIT
- `@types/node`: MIT
- `tsx`: MIT
- `typescript`: Apache-2.0

Their own license texts and notices apply when npm installs them. The root MIT
license does not relicense those packages. `package-contents.json` records the
locked dependency versions, package metadata licenses, integrity strings, and
the SHA256 of every packaged file. Its metadata license labels are not a
replacement for the original license texts.

## Game ownership and affiliation

Darkest Dungeon and its game data, names, and trademarks belong to their
respective owners. DD1 Copilot is an unofficial project and is not
affiliated with or endorsed by Red Hook Studios or the upstream projects named
above.
