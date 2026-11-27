---
title: "Connect SAP to Claude Code, Codex, Cursor, Claude Desktop and VS Code"
description: "Add the sap-ui-automation MCP server to your client with npx -y sap-ui-automation: Node.js 22 or later, on the machine where SAP GUI or Chrome runs."
---

# Install in your client

The server is the npm package `sap-ui-automation`. Every client starts it
the same way, as a local (stdio) MCP server:

```sh
npx -y sap-ui-automation
```

You need **Node.js 22 or later** on the machine where the client runs
(`node -v`). The server must run on the same machine as your SAP GUI or
Chrome: it reads the screens open there. TypeScript tests and configs (`*.sap.ts`, `sap.config.ts`, `sap_code_test`)
want **22.18 or later**, which loads TypeScript without a flag. The test
command also works from 22.6 (it re-runs itself with
`--experimental-strip-types`) and `sap_code_test` from 22.13; on an older
Node they say to use 22.18 instead of failing with "Unknown file
extension".

Pick your client below. Each one names the server `sap-ui-automation`.

::: tip The quick way
`setup` finds the coding agents on this machine (Claude Code, Codex, Claude
Desktop, Cursor, Windsurf, VS Code, GitHub Copilot CLI, Gemini CLI, OpenCode,
Kiro, Zed, Goose, Amp and [more](../reference/cli.md#the-agents)), asks
which to set up (the ones found are ticked), and gives each one the server
and the skills `sap-ui-automation` and `sap-ui-automation-cli`. It never
replaces an existing `sap-ui-automation` entry (with `--extension` it only
adds `SAP_BROWSER=extension` to it).

```sh
npx -y sap-ui-automation setup --dry-run   # show what it would change
npx -y sap-ui-automation setup             # change it
npx -y sap-ui-automation setup --yes       # no question: every agent found
npx -y sap-ui-automation setup --agent claude-code,codex   # these agents only
```

`--no-skills` skips the skills, `--no-mcp` the server. It adds no settings,
so `SAP_WRITE` is `confirm`, the default (below). With the Chrome extension, run `setup --extension`: new
entries get `SAP_BROWSER=extension`, and the extension's helper is installed
too. Then run `npx -y sap-ui-automation doctor` to check what the server can
reach (SAP GUI scripting, Chrome). Or have your agent do all of it: [Set up
with your agent](setup-prompt.md).

For an agent `setup` does not know, `npx skills add DidroAI/sap-ui-mcp`
installs the skills; add the server in its MCP settings as below.
:::

::: warning Windows
Some clients cannot start `npx` directly on Windows (it is `npx.cmd`) and
show the server as failed or "connection closed". Then use `cmd` as the
command and `/c npx -y sap-ui-automation` as its arguments:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "sap-ui-automation"] }
```

`setup` does this for you on Windows.
:::

Write controls are configurable. Settings are environment
variables of the server; all of them are in
[Configuration](../reference/configuration.md). The one to decide first is
`SAP_WRITE`:

- `confirm` (the default): the server requests client approval for flagged writes.
  Codex Full Access can accept automatically. This needs a client that supports MCP elicitation: Claude
  Code, VS Code and Codex do. A client that cannot ask gets every such
  action refused ([which clients can ask](../concepts/confirm-mode.md#which-clients-can-ask)).
- `off`: read-only, anything that may save is refused. The snippets below
  set it for the clients that cannot ask, so the server says nothing about
  questions it cannot put. Use it too in Codex's Full Access mode.
- `on`: such actions run; your client's own tool approval is then the only
  check.

## Claude Code

::: code-group

```sh [CLI]
# requests MCP client approval for flagged writes (SAP_WRITE=confirm, the default):
claude mcp add sap-ui-automation --scope user -- npx -y sap-ui-automation

# read-only:
claude mcp add --scope user --env SAP_WRITE=off --transport stdio sap-ui-automation -- npx -y sap-ui-automation
```

```text [Plugin]
/plugin marketplace add DidroAI/sap-ui-mcp
/plugin install sap-ui-automation@sap-ui-automation
```

:::

`--scope user` makes it available in every project; leave it out to add it
to the current project only. Check it with `claude mcp get sap-ui-automation`, or `/mcp`
in a session. Claude Code asks in interactive sessions; in `claude -p` a
write under `confirm` does not run unless a hook answers.

The **plugin** brings the server and two skills: `sap-ui-automation`, which teaches
the agent how to work in SAP transactions with the tools, and `sap-ui-automation-cli`,
the same work from the shell with the CLI. From your shell, the same is
`claude plugin marketplace add DidroAI/sap-ui-mcp` then
`claude plugin install sap-ui-automation@sap-ui-automation`. The plugin starts the
server with `SAP_WRITE` from your environment (default `confirm`). Its files:
[`.claude-plugin/plugin.json`](https://github.com/DidroAI/sap-ui-mcp/blob/main/.claude-plugin/plugin.json),
[`.mcp.json`](https://github.com/DidroAI/sap-ui-mcp/blob/main/.mcp.json),
[`skills/sap-ui-automation`](https://github.com/DidroAI/sap-ui-mcp/blob/main/skills/sap-ui-automation/SKILL.md),
[`skills/sap-ui-automation-cli`](https://github.com/DidroAI/sap-ui-mcp/blob/main/skills/sap-ui-automation-cli/SKILL.md).

## Claude Desktop

**One click:** download `sap-ui-automation-<version>.mcpb` from the
[latest release](https://github.com/DidroAI/sap-ui-mcp/releases/latest)
and open it (double-click, or drag it onto Claude Desktop, or **Settings >
Extensions > Advanced settings > Install Extension…**). Claude Desktop shows
the settings: writes (`confirm`, the default, `off` or `on`), allowed systems and
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
    "sap-ui-automation": {
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

```json [Windows]
{
  "mcpServers": {
    "sap-ui-automation": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

:::

The file is `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

The snippets set `SAP_WRITE` to `off` (read-only): Claude Desktop does not
document whether it asks about a server's questions (MCP elicitation), so
under the default `confirm` a write may simply be refused, with a note in
the server's log. Try `confirm` on a test system before you rely on it.

## Codex

::: code-group

```sh [CLI]
# requests MCP client approval for flagged writes (SAP_WRITE=confirm, the default):
codex mcp add sap-ui-automation -- npx -y sap-ui-automation

# read-only (use it in Full Access mode):
codex mcp add sap-ui-automation --env SAP_WRITE=off -- npx -y sap-ui-automation
```

```toml [~/.codex/config.toml]
[mcp_servers.sap-ui-automation]
command = "npx"
args = ["-y", "sap-ui-automation"]

[mcp_servers.sap-ui-automation.env]
SAP_WRITE = "confirm"   # confirm (default) | off (read-only) | on
```

:::

The Codex CLI, the IDE extension and the desktop app share this
configuration. `codex mcp list` shows it. Codex asks from version 0.119.
Two exceptions: `codex exec` cancels every question, so a write under
`confirm` does not run; and in **Full Access** mode Codex accepts the
question without showing it, so `confirm` protects nothing there: set
`SAP_WRITE=off`.

## Cursor

<a href="https://cursor.com/install-mcp?name=sap-ui-automation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC11aS1hdXRvbWF0aW9uIl19%3D%3D"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add sap-ui-automation MCP server to Cursor" height="32"></a>

The button opens Cursor and asks you to confirm. Its link is
`cursor://anysphere.cursor-deeplink/mcp/install?name=sap-ui-automation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC11aS1hdXRvbWF0aW9uIl19==`,
where `config` is the base64 of `{"command":"npx","args":["-y","sap-ui-automation"]}`.

By hand, add it to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json`
in a project:

```json
{
  "mcpServers": {
    "sap-ui-automation": {
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

It appears under **Settings > MCP**.

The snippet sets `SAP_WRITE` to `off` (read-only). Cursor lists MCP
elicitation as supported, but users report the question not showing (on
Windows), its buttons hidden until the tool row is expanded, and a short
timeout. The button installs the server with the default, `confirm`: a
question that is not shown is a write that does not run. Before you rely
on `confirm`, try a harmless write on a test system.

## VS Code (GitHub Copilot)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--ui--automation-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-ui-automation%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-ui-automation%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_sap--ui--automation-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-ui-automation%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-ui-automation%2522%255D%257D)

The button opens the server's details in VS Code to review before you
install. Recent VS Code versions recommend the **Copilot user file** for a
server you want in every workspace: `~/.copilot/mcp-config.json` (or
`$COPILOT_HOME/mcp-config.json`), which the Copilot CLI reads too. For a
team, put the same `mcpServers` block in `.mcp.json` at the workspace root.

::: code-group

```json [~/.copilot/mcp-config.json]
{
  "mcpServers": {
    "sap-ui-automation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "confirm" },
      "tools": ["*"]
    }
  }
}
```

```sh [code --add-mcp]
code --add-mcp '{"name":"sap-ui-automation","type":"stdio","command":"npx","args":["-y","sap-ui-automation"]}'
```

```json [.vscode/mcp.json]
{
  "servers": {
    "sap-ui-automation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sap-ui-automation"]
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
VS Code asks about each write in the chat (from 1.102). The Copilot file
above sets `confirm`; the install button and `code --add-mcp` set no
variable, so the server starts with the same default, `confirm`.

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
    "sap-ui-automation": {
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

Whether Windsurf asks about a server's questions (MCP elicitation) was not
checked: the snippet sets `off` (read-only) until you have tried `confirm`, the default, on a test system.

## Other clients

Any MCP client that starts local (stdio) servers can run it. Give it:

| Field | Value |
| --- | --- |
| name | `sap-ui-automation` |
| transport | stdio |
| command | `npx` (Windows: `cmd`) |
| arguments | `-y sap-ui-automation` (Windows: `/c npx -y sap-ui-automation`) |
| environment | optional: `SAP_WRITE`, `SAP_ALLOW_SYSTEMS` and the others in [Configuration](../reference/configuration.md) |

Most clients take the same JSON block as Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "sap-ui-automation": { "command": "npx", "args": ["-y", "sap-ui-automation"] }
  }
}
```

To skip the `npx` download at each start, install it once with
`npm i -g sap-ui-automation` and use `sap-ui-automation` as the command,
with no arguments.

## Check it

1. Run `npx -y sap-ui-automation doctor`. It checks SAP GUI scripting (on
   Windows) and Chrome, and says what to do for each ✗
   ([FAQ and troubleshooting](../faq.md)).
2. Restart your client, open an SAP screen, and ask: *"Look at my SAP screen
   and tell me what you see."* The agent should call `sap_sessions` and
   `sap_look`.

Next: [Your first session](first-session.md). Ready-made snippets and example
prompts for each client are in
[examples/clients](https://github.com/DidroAI/sap-ui-mcp/tree/main/examples/clients).

## Badges for the README

```md
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-ui-automation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC11aS1hdXRvbWF0aW9uIl19%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--ui--automation-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-ui-automation%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-ui-automation%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_sap--ui--automation-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-ui-automation%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-ui-automation%2522%255D%257D)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-Download_.mcpb-D97757?style=flat-square&logo=claude&logoColor=white)](https://github.com/DidroAI/sap-ui-mcp/releases/latest/download/sap-ui-automation.mcpb)
```

GitHub does not follow `cursor://` or `vscode:` links in a README, so the
badges use the HTTPS forms: `cursor.com/install-mcp` and VS Code's
`vscode.dev/redirect` wrapper, both of which hand over to the editor.
