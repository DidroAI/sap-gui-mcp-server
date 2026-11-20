# CLI for coding agents

Coding agents such as Claude Code, Codex and Cursor can run shell commands.
For them, the same tools are also commands: the agent runs `sap-gui look`,
reads a short answer, and opens the screen file only when it needs it. This
keeps screens out of the conversation until they matter, and works in
agents that have no MCP support.

::: info Version
The agent CLI ships with the SDK and the test runner. Check
`npx sap-gui --help` for the commands of the version you have.
:::

## Commands

The package installs two names for the same program: `sap-gui` and
`sap-gui-mcp-server`. With no arguments it serves MCP over stdio.

| Command | Does | Same as |
| --- | --- | --- |
| `sap-gui sessions` | lists the SAP sessions open now | `sap_sessions` |
| `sap-gui use <ref>` | makes a session the active one | `sap_use` |
| `sap-gui look [--full] [--diff] [--id <id> [--rows 0-50] [--cols A,B]] [--print]` | writes the screen to a file and prints one line with its path (`--print` prints the screen) | `sap_look` |
| `sap-gui act '<json>' [--full]` | runs one action ([actions](../reference/actions.md)) | `sap_act` |
| `sap-gui act set <id> <value>`, `press <id>`, `key <n>`, `okcode <cmd>`, `select <id>`, `check <id> [true\|false]`, `combo <id> [key]`, `f4 <id>`, `dblclick <id>`, `scroll <id> <to>` | shorthand for one action | `sap_act` |
| `sap-gui confirm <token>` | runs an action held for confirmation | `sap_confirm` |
| `sap-gui screenshot` | writes a PNG of the window or tab | `sap_screenshot` |
| `sap-gui record <op> ['<json>']` | `start <name>`, `assert '{"check":"status","contains":"saved"}'`, `stop`, `list`, ... | `sap_record` |
| `sap-gui daemon status\|stop` | the background process that keeps the session attached between commands | |

Each command prints one short line and the path of the screen file.
`look`, `act`, `screenshot` and `record` take `--session <ref>`. Exit codes:
0 done, 1 error or refused, 2 usage, 3 held for confirmation (run
`sap-gui confirm <token>` after the user's yes).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SAP_CLI_DIR` | `.sap-gui/screens` | where answers and screens are written |
| `SAP_CLI_IDLE` | `30` | minutes without a command before the daemon exits |
| `SAP_CLI_SESSION` | one daemon per directory | a name: one daemon for every directory that sets it |

The daemon keeps the `SAP_*` settings it started with. A later command with
different settings is refused: run `sap-gui daemon stop` first.

 The same settings apply as for the MCP server: writes stay refused
unless `SAP_WRITE` allows them ([configuration](../reference/configuration.md)).

## Teaching the agent

`sap-gui install --skills` copies the bundled skills, among them
[`sap-gui-drive`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/skills/sap-gui-drive/SKILL.md)
and a `sap-gui-cli` skill on driving SAP through these commands, into the
agent's folder: `.claude/skills` (Claude), `.agents/skills` (Codex) or
`.cursor/rules/<name>.mdc` (Cursor), chosen with
`--target claude|codex|cursor|all`; `--global` uses `~/.claude/skills` and
`$CODEX_HOME/skills` instead. `sap-gui init` does this as part of setting a project
up. The skill tells the agent
how SAP screens behave: fields take effect on Enter, popups come first,
value help instead of guessed codes, and never work around the write
setting.

## MCP or CLI?

Use MCP when the client supports it: the answers arrive as tool results and
the client can ask you to confirm writes. Use the CLI when the agent has
only a shell, or when you want the agent to write SDK scripts and tests
from what it did (every action also prints its SDK line, see
[Writing tests](sdk-tests.md)).
