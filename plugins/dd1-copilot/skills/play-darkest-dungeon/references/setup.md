# Local setup and connection recovery

Requires Windows, Node.js 24+, and a separately deployed compatible DD1 bridge DLL. The plugin carries its compiled MCP runtime and production dependencies. It does not carry the game, DLL, saves or campaign records.

1. From the DD1-Copilot checkout, run `npm ci` and `npm run plugin:package`.
2. Bind the intended save and game installation using `scripts/configure-plugin.ps1`. Existing project setup can be imported with `-FromProject`; use `-CheckOnly` to preview without writing configuration.
3. Register/install with `scripts/install-plugin.ps1`. Refresh or restart Codex, then use a new chat if the current tool list has not changed.
4. Launch the game using the existing `start_dd1_agent.cmd` so the command pipe is enabled and speech settings apply. Enter the configured save.

Default private settings: `%LOCALAPPDATA%/DD1AgentBridge/copilot-plugin.local.json`. `DD1_PLUGIN_CONFIG` selects another configuration file. The file has `logPath`, `commandPipe`, `campaignId`, `saveDirectory` and optionally `databasePath`. Explicit `DD1_BLINDEST_LOG`/`DD1_COMMAND_PIPE` override their fields; explicit memory environment variables override the memory binding as a unit. Paths must be absolute. Neither plugin cache updates nor uninstalling the plugin delete the external database/configuration.

`node <installed-plugin>/scripts/server.mjs --check` validates runtime/configuration and reads the binding registry; it sends no commands and does not open/write the database. It does not prove that the game is connected. Call `get_state` and inspect source/command health, then use `refresh_state` for fresh game evidence.

MCP initialization and tool discovery do not claim the command pipe. The first game command claims exclusive control for that session until it closes; another session receives a rejection before input is sent. Stop the old JSON-line live helper or the other controlling chat before taking control. Do not terminate unrelated Node processes. If the game is unavailable, preserve its records and report connection failure. If two saves conflict in the binding registry, resolve the configuration deliberately rather than creating another temporary database.
