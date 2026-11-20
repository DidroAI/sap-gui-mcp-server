# CLI for coding agents

Coding agents such as Claude Code, Codex and Cursor can run shell commands.
For them, the same tools are also commands: the agent runs `sap-gui look`,
reads a short answer, and opens the screen file only when it needs it. This
keeps screens out of the conversation until they matter, and works in
agents that have no MCP support.

::: warning Status
The agent CLI is being finished for this release. Command names below are
the planned ones; check `npx sap-gui --help` for the version you have.
:::

## Commands

The package installs two names for the same program: `sap-gui` and
`sap-gui-mcp-server`. With no arguments it serves MCP over stdio.

| Command | Does | Same as |
| --- | --- | --- |
| `sap-gui sessions` | lists the SAP sessions open now | `sap_sessions` |
| `sap-gui use <ref>` | makes a session the active one | `sap_use` |
| `sap-gui look [--full]` | writes the screen to a file and prints one line with its path | `sap_look` |
| `sap-gui act '<json>'` | runs one action ([actions](../reference/actions.md)) | `sap_act` |
| `sap-gui confirm <token>` | runs an action held for confirmation | `sap_confirm` |
| `sap-gui screenshot` | writes a PNG of the window or tab | `sap_screenshot` |
| `sap-gui record ...` | starts, stops and checks a recording | `sap_record` |
| `sap-gui daemon status\|stop` | the background process that keeps the session attached between commands | |

Each command prints one short line and the path of the screen file. Screens
are written to `.sap-gui/` in the working directory (`SAP_CLI_DIR` changes
it). The same settings apply as for the MCP server: writes stay refused
unless `SAP_WRITE` allows them ([configuration](../reference/configuration.md)).

## Teaching the agent

`sap-gui install --skills` copies the [`sap-gui-drive`
skill](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/skills/sap-gui-drive/SKILL.md)
into the agent's skills folder (`--target claude|codex|cursor|all`,
`--global` for your user rather than the project). The skill tells the agent
how SAP screens behave: fields take effect on Enter, popups come first,
value help instead of guessed codes, and never work around the write
setting.

## MCP or CLI?

Use MCP when the client supports it: the answers arrive as tool results and
the client can ask you to confirm writes. Use the CLI when the agent has
only a shell, or when you want the agent to write SDK scripts and tests
from what it did (every action also prints its SDK line, see
[Writing tests](sdk-tests.md)).
