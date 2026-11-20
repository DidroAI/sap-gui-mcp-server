# Install in your client

The server is the npm package `sap-gui-mcp-server`. Every client starts it
the same way, as a local (stdio) MCP server:

```sh
npx -y sap-gui-mcp-server
```

You need **Node.js 22 or later** on the machine where the client runs
(`node -v`). The server must run on the same machine as your SAP GUI or
Chrome: it reads the screens open there.

Pick your client below. Each one names the server `sap-gui`.

::: tip The quick way
`setup` finds Claude Code, Codex and Claude Desktop on this machine and adds
the server to each, without touching an existing `sap-gui` entry:

```sh
npx -y sap-gui-mcp-server setup --dry-run   # show what it would change
npx -y sap-gui-mcp-server setup             # change it
```

Support for Cursor, VS Code and Windsurf in `setup` is coming; for now, use
the steps below for those. Then run `npx -y sap-gui-mcp-server doctor` to
check what the server can reach (SAP GUI scripting, Chrome). Or have your
agent do all of it: [Set up with your agent](setup-prompt.md).
:::

::: warning Windows
Some clients cannot start `npx` directly on Windows (it is `npx.cmd`) and
show the server as failed or "connection closed". Then use `cmd` as the
command and `/c npx -y sap-gui-mcp-server` as its arguments:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "sap-gui-mcp-server"] }
```

`setup` does this for you on Windows.
:::

Writes to SAP are refused until you allow them. Every snippet below can take
settings as environment variables, for example `SAP_WRITE=confirm` so that
each action that may write waits for your approval
([Confirm mode](../concepts/confirm-mode.md)). All the variables are in
[Configuration](../reference/configuration.md).

## Claude Code

::: code-group

```sh [CLI]
claude mcp add sap-gui --scope user -- npx -y sap-gui-mcp-server

# with a setting:
claude mcp add --scope user --env SAP_WRITE=confirm --transport stdio sap-gui -- npx -y sap-gui-mcp-server
```

```text [Plugin]
/plugin marketplace add DidroAI/sap-gui-mcp-server
/plugin install sap-gui@sap-gui-mcp-server
```

:::

`--scope user` makes it available in every project; leave it out to add it
to the current project only. Check it with `claude mcp get sap-gui`, or `/mcp`
in a session.

The **plugin** brings the server and the `sap-gui-drive` skill, which teaches
the agent how to work in SAP transactions. From your shell, the same is
`claude plugin marketplace add DidroAI/sap-gui-mcp-server` then
`claude plugin install sap-gui@sap-gui-mcp-server`. The plugin starts the
server with `SAP_WRITE` from your environment (default `off`). Its files:
[`.claude-plugin/plugin.json`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/.claude-plugin/plugin.json),
[`.mcp.json`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/.mcp.json),
[`skills/sap-gui-drive`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/skills/sap-gui-drive/SKILL.md).

## Claude Desktop

**One click:** download `sap-gui-mcp-server-<version>.mcpb` from the
[latest release](https://github.com/DidroAI/sap-gui-mcp-server/releases/latest)
and open it (double-click, or drag it onto Claude Desktop, or **Settings >
Extensions > Advanced settings > Install Extension…**). Claude Desktop shows
the settings: writes (`off`, `confirm` or `on`), allowed systems and
transactions, browser origins, and where recordings go. The bundle carries
the server and its dependencies; it runs with the Node.js that Claude Desktop
ships.

**By hand:** add the server to `claude_desktop_config.json`
(**Settings > Developer > Edit Config**), then quit and reopen Claude
Desktop.

::: code-group

```json [macOS]
{
  "mcpServers": {
    "sap-gui": {
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

```json [Windows]
{
  "mcpServers": {
    "sap-gui": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

:::

The file is `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

## Codex

::: code-group

```sh [CLI]
codex mcp add sap-gui -- npx -y sap-gui-mcp-server

# with a setting:
codex mcp add sap-gui --env SAP_WRITE=confirm -- npx -y sap-gui-mcp-server
```

```toml [~/.codex/config.toml]
[mcp_servers.sap-gui]
command = "npx"
args = ["-y", "sap-gui-mcp-server"]

[mcp_servers.sap-gui.env]
SAP_WRITE = "off"
```

:::

The Codex CLI, the IDE extension and the desktop app share this
configuration. `codex mcp list` shows it.

## Cursor

<a href="https://cursor.com/install-mcp?name=sap-gui&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC1ndWktbWNwLXNlcnZlciJdfQ%3D%3D"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add sap-gui MCP server to Cursor" height="32"></a>

The button opens Cursor and asks you to confirm. Its link is
`cursor://anysphere.cursor-deeplink/mcp/install?name=sap-gui&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC1ndWktbWNwLXNlcnZlciJdfQ==`,
where `config` is the base64 of `{"command":"npx","args":["-y","sap-gui-mcp-server"]}`.

By hand, add it to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json`
in a project:

```json
{
  "mcpServers": {
    "sap-gui": {
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

It appears under **Settings > MCP**.

## VS Code (GitHub Copilot)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--gui-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_sap--gui-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)

The button opens the server's details in VS Code to review before you
install. Recent VS Code versions recommend the **Copilot user file** for a
server you want in every workspace: `~/.copilot/mcp-config.json` (or
`$COPILOT_HOME/mcp-config.json`), which the Copilot CLI reads too. For a
team, put the same `mcpServers` block in `.mcp.json` at the workspace root.

::: code-group

```json [~/.copilot/mcp-config.json]
{
  "mcpServers": {
    "sap-gui": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" },
      "tools": ["*"]
    }
  }
}
```

```sh [code --add-mcp]
code --add-mcp '{"name":"sap-gui","type":"stdio","command":"npx","args":["-y","sap-gui-mcp-server"]}'
```

```json [.vscode/mcp.json]
{
  "servers": {
    "sap-gui": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"]
    }
  }
}
```

:::

`code --add-mcp`, the install button and `.vscode/mcp.json` write the
editor's own format, under **`servers`**, not `mcpServers`. VS Code documents
that format as part of its older local agent, which it plans to remove in
February 2027, so prefer the Copilot user file for a new setup. Run
**MCP: List Servers** to see the server, and use Copilot Chat in Agent mode.

## Windsurf

Windsurf's agent is now part of Devin Desktop. Open **Open MCP config file**
from Cascade's MCP menu, or edit the file yourself, then press refresh in the
MCP panel:

- macOS and Linux: `~/.config/devin/mcp_config.json`
- Windows: `%APPDATA%\devin\mcp_config.json`
- Older Windsurf versions: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "sap-gui": {
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

## Other clients

Any MCP client that starts local (stdio) servers can run it. Give it:

| Field | Value |
| --- | --- |
| name | `sap-gui` |
| transport | stdio |
| command | `npx` (Windows: `cmd`) |
| arguments | `-y sap-gui-mcp-server` (Windows: `/c npx -y sap-gui-mcp-server`) |
| environment | optional: `SAP_WRITE`, `SAP_ALLOW_SYSTEMS` and the others in [Configuration](../reference/configuration.md) |

Most clients take the same JSON block as Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "sap-gui": { "command": "npx", "args": ["-y", "sap-gui-mcp-server"] }
  }
}
```

To skip the `npx` download at each start, install it once with
`npm i -g sap-gui-mcp-server` and use `sap-gui-mcp-server` as the command,
with no arguments.

## Check it

1. Run `npx -y sap-gui-mcp-server doctor`. It checks SAP GUI scripting (on
   Windows) and Chrome, and says what to do for each ✗.
2. Restart your client, open an SAP screen, and ask: *"Look at my SAP screen
   and tell me what you see."* The agent should call `sap_sessions` and
   `sap_look`.

Next: [Your first session](first-session.md). Ready-made snippets and example
prompts for each client are in
[examples/clients](https://github.com/DidroAI/sap-gui-mcp-server/tree/main/examples/clients).

## Badges for the README

```md
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-gui&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC1ndWktbWNwLXNlcnZlciJdfQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--gui-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_sap--gui-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-Download_.mcpb-D97757?style=flat-square&logo=claude&logoColor=white)](https://github.com/DidroAI/sap-gui-mcp-server/releases/latest)
```

GitHub does not follow `cursor://` or `vscode:` links in a README, so the
badges use the HTTPS forms: `cursor.com/install-mcp` and VS Code's
`vscode.dev/redirect` wrapper, both of which hand over to the editor.
