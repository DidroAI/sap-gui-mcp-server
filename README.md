# sap-gui-mcp-server

Let an agent **see and drive the SAP screens you already have open**: SAP
GUI for Windows, SAP GUI for HTML (Web GUI) and SAP Fiori. An
[MCP](https://modelcontextprotocol.io) server for Claude, Codex, Cursor,
VS Code and any other MCP client.

- **Compact and complete.** One line per control, with SAP's own ids,
  labels, values and whether they can be edited: about 0.5–4.5k tokens per
  screen on real ECC and S/4 screens. After an action on the same screen,
  only what changed.
- **Writes off by default.** Actions that may save to SAP are refused
  unless you allow them, or asked about in your client first.
- **Your sessions, your authorisations.** It finds the sessions you have
  open and works in them as you. It never logs on and never stores a
  password.
- **Runs on your machine.** No telemetry, no hosted service. Screen content
  goes only to your MCP client, and from there to the model provider you
  chose.
- **Runs become tests.** Record what the agent did, replay it with no
  model, export it.

<!-- TODO(launch): a 20-second GIF: the agent reads VA03 in Web GUI and answers a question. -->

```
TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM ABA (800)
WINDOW wnd[0]  "Create Sales Order: Initial Screen"
btn[8]  button  Create with Reference (F8)
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
ctxtVBAK-VTWEG  field  Distribution Channel = ""  (edit)
```

## Install

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-gui&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC1ndWktbWNwLXNlcnZlciJdfQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--gui-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_sap--gui-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-gui%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-gui-mcp-server%2522%255D%257D)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-Download_.mcpb-D97757?style=flat-square&logo=claude&logoColor=white)](https://github.com/DidroAI/sap-gui-mcp-server/releases/latest)

You need Node.js 22 or later. Pick your client:

**Claude Code**

```sh
claude mcp add sap-gui --scope user -- npx -y sap-gui-mcp-server
```

or, with the skill, as a plugin: `/plugin marketplace add DidroAI/sap-gui-mcp-server`
then `/plugin install sap-gui@sap-gui-mcp-server`.

**Claude Desktop**: download `sap-gui-mcp-server-<version>.mcpb` from the
[latest release](https://github.com/DidroAI/sap-gui-mcp-server/releases/latest)
and open it, or add the JSON below to `claude_desktop_config.json`.

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** and most other clients:

```json
{
  "mcpServers": {
    "sap-gui": { "command": "npx", "args": ["-y", "sap-gui-mcp-server"] }
  }
}
```

**VS Code**

```sh
code --add-mcp '{"name":"sap-gui","type":"stdio","command":"npx","args":["-y","sap-gui-mcp-server"]}'
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.sap-gui]
command = "npx"
args = ["-y", "sap-gui-mcp-server"]
```

Or let it configure the clients it finds (Claude Code, Codex, Claude
Desktop), then check what it can reach:

```sh
npx -y sap-gui-mcp-server setup
npx -y sap-gui-mcp-server doctor
```

On Windows, some clients cannot start `npx` directly: use
`"command": "cmd", "args": ["/c", "npx", "-y", "sap-gui-mcp-server"]`
(`setup` does this for you). One-click buttons, the Claude Code plugin and
every client: [Installation](docs/getting-started/installation.md).

Then open SAP and ask: *"Look at my SAP screen and tell me which fields are
required."*

## What you need on the SAP side

| Surface | You need |
| --- | --- |
| SAP GUI for Windows | SAP GUI scripting enabled in SAP GUI and allowed on the system ([guide](docs/guides/sap-gui-windows.md)) |
| SAP GUI without scripting | Experimental network reader ([guide](docs/guides/network-reader.md)) |
| Web GUI and Fiori | Chrome or Edge with remote debugging allowed, logged on ([guide](docs/guides/chrome.md)) |

Web GUI and Fiori work from Windows, macOS and Linux.

## Documentation

- [Getting started](docs/getting-started/index.md) and
  [your first session](docs/getting-started/first-session.md)
- Concepts: [surfaces](docs/concepts/surfaces.md),
  [the screen view](docs/concepts/screen-view.md),
  [actions](docs/concepts/actions.md),
  [safety model](docs/concepts/safety.md)
- Guides: [recording and replay](docs/guides/record-replay.md),
  [writing tests](docs/guides/sdk-tests.md),
  [CLI for coding agents](docs/guides/cli-for-agents.md)
- Reference: [tools](docs/reference/tools.md),
  [actions](docs/reference/actions.md),
  [configuration](docs/reference/configuration.md),
  [CLI](docs/reference/cli.md)
- [Security and data handling](docs/security.md) ·
  [FAQ and troubleshooting](docs/faq.md) ·
  [Comparison](docs/comparison.md) ·
  [Benchmarks](docs/benchmarks.md)

The same pages ship in the npm package under `docs/`, so an agent can read
them offline. The [`sap-gui-drive` skill](skills/sap-gui-drive/SKILL.md)
teaches an agent how SAP screens behave.

## Status

0.1.0, the first public version. It works on real systems, but parts are
young; each guide lists its limits. Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md) (the tests run without an SAP system).
Report security issues as described in [SECURITY.md](SECURITY.md).

## Licence and trademarks

MIT, see [LICENSE](LICENSE).

This project is not affiliated with, endorsed by or sponsored by SAP SE.
SAP, SAP GUI, SAP Fiori, SAPUI5, SAP S/4HANA, ABAP and other SAP products
and services mentioned here are trademarks or registered trademarks of SAP
SE (or an SAP affiliate company) in Germany and other countries. All other
names are the property of their owners.
