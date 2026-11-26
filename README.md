# SAP UI Automation

Let an AI agent **see and drive the SAP screens you have open**: SAP GUI
for Windows, SAP GUI for HTML (Web GUI) and SAP Fiori. It is an
[MCP](https://modelcontextprotocol.io) server for Claude Code, Codex,
Cursor, Claude Desktop, VS Code and other MCP clients, a command line for
agents without MCP, and an SDK for scripts and tests.

Why: from a screenshot or a page's HTML, an agent has to guess which SAP
field is which. This server reads the screen the way SAP models it and
gives the agent one line per control, with SAP's own ids, labels, values
and whether each can be edited. After an action on the same screen, it
sends only what changed.

```
TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM ABA (800)
WINDOW wnd[0]  "Create Sales Order: Initial Screen"
btn[8]  button  Create with Reference (F8)
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
ctxtVBAK-VTWEG  field  Distribution Channel = ""  (edit)
```

- **Writes are off by default.** Actions that may save to SAP are refused
  unless you allow them, or your client asks you first
  ([safety model](docs/concepts/safety.md)).
- **Your sessions, your authorisations.** It works in the sessions you
  opened, as you. The server never logs on and never sees a password.
- **Runs on your machine.** No telemetry, no hosted service. Screen content
  goes only to your MCP client, and from there to the model provider you
  chose ([security](docs/security.md)).
- **Runs become tests.** Record what the agent did, replay it with no
  model, export it.

## Where it runs

| Surface | Windows | macOS | Linux | How it is read |
| --- | --- | --- | --- | --- |
| SAP GUI for Windows | yes | – | – | SAP GUI scripting (default), or the network reader (DIAG, experimental). Both run unless `SAP_GUI_METHOD` pins one |
| Web GUI | yes | yes | yes | Chrome, in one of three modes (`SAP_BROWSER`): `launch`, `attach`, `extension` |
| Fiori | yes | yes | yes | the same Chrome |
| SAP GUI for Java | – | – | – | not supported |

You need Node.js 22 or later. Not sure what you need?
[Choose your setup](docs/getting-started/choose.md) asks four questions.

## Quick start

### 1. Add it to your agent

```sh
npx -y sap-ui-automation setup --dry-run   # what it would change
npx -y sap-ui-automation setup             # add the server and the skills
npx -y sap-ui-automation doctor            # check what it can reach
```

`setup` finds your coding agents (Claude Code, Codex, Cursor, Copilot,
Gemini CLI, OpenCode, Zed, Goose and [more](docs/reference/cli.md#the-agents)),
lets you pick, and gives each one the server and the skills
`sap-ui-automation` and `sap-ui-automation-cli`. Restart the agent afterwards. One client by hand:

| Client | |
| --- | --- |
| Claude Code | `claude mcp add sap-ui-automation --scope user -- npx -y sap-ui-automation`, or the plugin: `/plugin marketplace add DidroAI/sap-ui-automation`, then `/plugin install sap-ui-automation@sap-ui-automation` |
| Codex | `codex mcp add sap-ui-automation -- npx -y sap-ui-automation` |
| Claude Desktop | open [`sap-ui-automation.mcpb`](https://github.com/DidroAI/sap-ui-automation/releases/latest/download/sap-ui-automation.mcpb) from the latest release |
| Cursor | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-ui-automation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC11aS1hdXRvbWF0aW9uIl19%3D%3D) |
| VS Code | `code --add-mcp '{"name":"sap-ui-automation","type":"stdio","command":"npx","args":["-y","sap-ui-automation"]}'` |
| Windsurf and other MCP clients | a stdio server with the command `npx -y sap-ui-automation` |

Every client, Windows notes and write settings:
[Install in your client](docs/getting-started/installation.md).

### 2. Open SAP

**Web GUI and Fiori in Chrome.** Pick a browser mode with `SAP_BROWSER` in
the server's environment ([guide](docs/guides/chrome.md)):

- `launch` (default): the server opens its own Chrome window. Run
  `npx -y sap-ui-automation browser`, open your SAP address there and log
  on once.
- `extension`: your everyday Chrome, through the **UI Automation for SAP**
  extension. Add it from the
  [Chrome Web Store](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn),
  then run `npx -y sap-ui-automation setup --extension`, which sets up
  your agent apps, the skills and the extension's helper in one go
  ([steps](docs/guides/chrome.md#install-the-extension)).
- `attach`: your running Chrome or Edge, with remote debugging allowed in
  `chrome://inspect/#remote-debugging`.

**SAP GUI for Windows.** Turn scripting on in SAP GUI (Options →
Accessibility & Scripting → Scripting) and have it allowed on the SAP
system (`sapgui/user_scripting = TRUE`)
([guide](docs/guides/sap-gui-windows.md)). Where scripting is not allowed,
the experimental [network reader](docs/guides/network-reader.md) reads SAP
GUI's traffic through a local SAProuter instead.

Then ask your agent: *"Look at my SAP screen and tell me which fields are
required."* ([Your first session](docs/getting-started/first-session.md))

### Agents with a shell, without MCP

The `sap-gui` command does the same work from the shell, and writes
screens to files so they stay out of the conversation until needed
([guide](docs/guides/cli-for-agents.md)):

```sh
npm install -g sap-ui-automation
sap-gui install --skills --target all   # skills for Claude Code, Codex and Cursor, in this project
sap-gui look
sap-gui act set ctxtVBAK-VBELN 4711
```

### Scripts and recorded tests

```sh
npm install --save-dev sap-ui-automation
npx sap-ui-automation init    # sap.config.ts, an example test, skills
npx sap-ui-automation test
```

[Writing tests with the SDK](docs/guides/sdk-tests.md) ·
[Recording and replay](docs/guides/record-replay.md): record an agent's
run, replay it with no model, export it to Playwright, VBScript, Gherkin or
SAP Cloud ALM.

## Writes

Every snippet above is read-only: writes are refused. Set `SAP_WRITE` in
the server's environment to change that:

- `confirm`: your client asks you before each write. Claude Code, VS Code
  and Codex can ask; other clients may refuse the write instead
  ([which clients can ask](docs/concepts/confirm-mode.md#which-clients-can-ask)).
- `on`: writes run; your client's tool approval is the only check.

Use a test system and a user with only the authorisations you want the
agent to have. [Safety model](docs/concepts/safety.md) says what the guard
catches and what it does not.

## Status and limits

Version 0.2: early. It works on real ECC and S/4HANA systems, but parts
are young.

- **Experimental:** the network reader for SAP GUI without scripting
  (read-only tasks on one system so far). Record and replay have been
  checked live on Web GUI only.
- **The Chrome extension** is in the Chrome Web Store as an unlisted item:
  it installs from its link, and does not show up in the store's search.
- **Not supported:** SAP GUI for Java, Firefox, Safari, SNC-encrypted
  connections with the network reader.
- No benchmark results are published yet ([benchmarks](docs/benchmarks.md)).

Each guide ends with the limits of its surface.

## Documentation

- [Getting started](docs/getting-started/index.md) ·
  [Choose your setup](docs/getting-started/choose.md) ·
  [Install in your client](docs/getting-started/installation.md) ·
  [Your first session](docs/getting-started/first-session.md)
- Guides: [Chrome: Web GUI and Fiori](docs/guides/chrome.md) ·
  [SAP GUI for Windows](docs/guides/sap-gui-windows.md) ·
  [Network reader](docs/guides/network-reader.md) ·
  [CLI for coding agents](docs/guides/cli-for-agents.md) ·
  [Writing tests](docs/guides/sdk-tests.md) ·
  [Recording and replay](docs/guides/record-replay.md)
- Concepts: [surfaces](docs/concepts/surfaces.md) ·
  [the screen view](docs/concepts/screen-view.md) ·
  [actions](docs/concepts/actions.md) ·
  [safety model](docs/concepts/safety.md)
- Reference: [MCP tools](docs/reference/tools.md) ·
  [actions](docs/reference/actions.md) ·
  [configuration](docs/reference/configuration.md) ·
  [CLI](docs/reference/cli.md)
- [Security and data handling](docs/security.md) ·
  [FAQ and troubleshooting](docs/faq.md) ·
  [Comparison](docs/comparison.md)

The same pages ship in the npm package under `docs/`, so an agent can read
them offline.

## Help and contributing

- Setup does not work: run `npx -y sap-ui-automation doctor`, read the
  [FAQ](docs/faq.md), then open a
  [setup problem](https://github.com/DidroAI/sap-ui-automation/issues/new?template=setup_problem.yml)
  with its output.
- Bugs and ideas: [issues](https://github.com/DidroAI/sap-ui-automation/issues/new/choose).
  Leave real SAP data out.
- Security issues: privately, as [SECURITY.md](SECURITY.md) says.
- Code: [CONTRIBUTING.md](CONTRIBUTING.md). The tests run without an SAP
  system.

## Licence and trademarks

MIT, see [LICENSE](LICENSE).

This project is not affiliated with, endorsed by or sponsored by SAP SE.
SAP, SAP GUI, SAP Fiori, SAPUI5, SAP S/4HANA, ABAP and other SAP products
and services mentioned here are trademarks or registered trademarks of SAP
SE (or an SAP affiliate company) in Germany and other countries. All other
names are the property of their owners.
