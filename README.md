<img src="assets/icon.png" alt="" width="72" align="right">

# SAP UI Automation

[![npm](https://img.shields.io/npm/v/sap-ui-automation?label=npm)](https://www.npmjs.com/package/sap-ui-automation)
[![CI](https://github.com/DidroAI/sap-ui-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/DidroAI/sap-ui-automation/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Let an AI agent **see and drive the SAP screens you have open**: SAP GUI
for Windows, SAP GUI for HTML (Web GUI) and SAP Fiori. It is an
[MCP](https://modelcontextprotocol.io) server for Claude Code, Codex,
Cursor, Claude Desktop, VS Code and other MCP clients, a command line for
agents without MCP, and an SDK for scripts and tests. For Web GUI and
Fiori in your everyday Chrome, add the
[UI Automation for SAP](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn)
extension.

Documentation: [docs.didro.ai/sap-ui-automation](https://docs.didro.ai/sap-ui-automation/).

> MIT licence. An independent open-source project, not affiliated with or
> endorsed by SAP. SAP, SAP GUI and SAP Fiori are trademarks of SAP SE.

Why: from a screenshot or a page's HTML, an agent has to guess which SAP
field is which. This server reads the screen the way SAP models it and
gives the agent one line per control, with SAP's own ids, labels, values
and whether each can be edited. After an action on the same screen, it
sends only what changed. By default, every write waits for your yes.

```
TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM ABA (800)
WINDOW wnd[0]  "Create Sales Order: Initial Screen"
btn[8]  button  Create with Reference (F8)
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
```

## Set it up with your agent

Paste this into Claude Code, Codex, Cursor or another agent that can run
commands on your machine. It needs Node.js 22 or later.

```text
Set up sap-ui-automation for me (npm package sap-ui-automation, https://github.com/DidroAI/sap-ui-automation). Say what each command does before you run it, and wait for me when I have to click something.
Rules: never type, ask for or store an SAP password, and never log on to SAP for me. Do not set or change SAP_WRITE. Do not save, post or change anything in SAP. Ask before you install software.
1. Check node -v is 22 or later; if not, tell me how to install it and stop.
2. Run npx -y sap-ui-automation setup --dry-run, show me the result, then run it without --dry-run.
3. Run npx -y sap-ui-automation doctor. For each ✗, tell me what to do (the → line says it), wait, and run doctor again. For Web GUI or Fiori, run npx -y sap-ui-automation browser and ask me to log on in the window it opens.
4. Ask me to open an SAP screen, then run npx -y sap-ui-automation sessions and npx -y sap-ui-automation look --print, and describe the screen in three lines.
5. Report in at most ten lines: the version, the agents setup changed, each doctor area (✓ or ✗) and what is left for me, whether I must restart an agent, and that each write in SAP will wait for my yes.
```

The longer version, with the SAP GUI and Chrome steps spelled out:
[Set up with your agent](docs/getting-started/setup-prompt.md). What an
agent should do with each line `setup` and `doctor` print:
[Setup steps for agents](docs/agent-setup.md).

## Where it runs

| Surface | Windows | macOS | Linux | How it reads and drives SAP |
| --- | --- | --- | --- | --- |
| SAP GUI for Windows | yes | – | – | SAP GUI scripting (default); or the network reader (DIAG, experimental) where scripting is not allowed |
| Web GUI | yes | yes | yes | Chrome: a window the server opens (`launch`), your Chrome through the [UI Automation for SAP](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn) extension (`extension`), or a running Chrome or Edge (`attach`) |
| Fiori | yes | yes | yes | the same Chrome modes |
| SAP GUI for Java | – | – | – | not supported |

As an MCP server for Claude Code, Codex, Cursor, Claude Desktop, VS Code
and other MCP clients; as the `sap-gui` command for agents with a shell;
as an SDK for scripts and tests.
[Choose your setup](docs/getting-started/choose.md) asks four questions.

- **You confirm each write.** An action that may save to SAP waits for
  your yes, and is refused where the client cannot ask.
  `SAP_WRITE=off` makes the server read-only.
- **Your sessions, your authorisations.** It works in the sessions you
  opened, as you. The server never logs on and never sees a password.
- **Runs on your machine.** No telemetry, no hosted service
  ([security](docs/security.md)).
- **Runs become tests.** Record what the agent did, replay it with no
  model, export it.

## Early benchmarks

Web GUI, 57 process scenarios on one SAP ECC and one S/4HANA lab system,
Claude Haiku 5.5, step-by-step procedure given, one run per scenario per
system (pilot of 2026-11-23). A run passes when database checks pass.
Only the 104 scenario-and-system pairs where every method had a valid run:

| Method | Success | $ / run | Seconds / run |
| --- | --- | --- | --- |
| sap-ui-automation MCP | 89% | $0.0053 | 22 |
| sap-ui-automation CLI | 88% | $0.0081 | 39 |
| Claude computer use | 90% | $0.0082 | 89 |
| Playwright CLI | 82% | $0.0156 | 88 |
| Playwright MCP | 88% | $0.0241 | 65 |
| Claude browser use | 84% | $0.0678 | 183 |
| Chrome DevTools MCP | 88% | $0.0816 | 75 |

At this sample size the success rates are within noise of each other
(about ±6 points); the cost and time differences are the result. On six
long ECC scenarios run with three Claude models, the MCP passed every run
and the other options cost 2 to 18 times more per successful task and
took 3.5 to 6 times longer
([by model](docs/benchmarks.md#4-six-long-ecc-scenarios-three-models)). On SAP
GUI for Windows, the same MCP passed 91% of 74 runs on ECC through
scripting (2026-11-25). Method, all tables, other models and caveats:
[Benchmarks](docs/benchmarks.md). The harness and raw results are not
public yet.

## Quick start

### 1. Add it to your agent

```sh
npx -y sap-ui-automation setup --dry-run   # what it would change
npx -y sap-ui-automation setup             # add the server and the skills
npx -y sap-ui-automation doctor            # check what it can reach
```

`setup` finds your coding agents (Claude Code, Codex, Cursor, Copilot,
Gemini CLI, OpenCode, Zed, Goose and [more](docs/reference/cli.md#the-agents))
and gives each one the server and the skills. Restart the agent
afterwards. One client by hand:

| Client | |
| --- | --- |
| Claude Code | `claude mcp add sap-ui-automation --scope user -- npx -y sap-ui-automation`, or the plugin: `/plugin marketplace add DidroAI/sap-ui-automation`, then `/plugin install sap-ui-automation@sap-ui-automation` |
| Codex | `codex mcp add sap-ui-automation -- npx -y sap-ui-automation` |
| Claude Desktop | open [`sap-ui-automation.mcpb`](https://github.com/DidroAI/sap-ui-automation/releases/latest/download/sap-ui-automation.mcpb) from the latest release |
| Cursor | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-ui-automation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC11aS1hdXRvbWF0aW9uIl19%3D%3D) |
| VS Code | `code --add-mcp '{"name":"sap-ui-automation","type":"stdio","command":"npx","args":["-y","sap-ui-automation"]}'` |
| Other MCP clients | a stdio server with the command `npx -y sap-ui-automation` |

Every client and Windows notes:
[Install in your client](docs/getting-started/installation.md).

### 2. Open SAP

- **Web GUI and Fiori** ([guide](docs/guides/chrome.md)): run
  `npx -y sap-ui-automation browser`, open your SAP address in the window
  it opens and log on. To use your everyday Chrome instead, add the
  [UI Automation for SAP](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn)
  extension and run `npx -y sap-ui-automation setup --extension`.
- **SAP GUI for Windows** ([guide](docs/guides/sap-gui-windows.md)): turn
  scripting on in SAP GUI (Options → Accessibility & Scripting →
  Scripting); the SAP system must allow it (`sapgui/user_scripting =
  TRUE`). Where it does not, the experimental
  [network reader](docs/guides/network-reader.md) reads SAP GUI's traffic
  through a local SAProuter.

Then ask your agent: *"Look at my SAP screen and tell me which fields are
required."* ([Your first session](docs/getting-started/first-session.md))

### Without MCP, and for tests

```sh
npm install -g sap-ui-automation
sap-gui look                              # the screen, written to a file
sap-gui act set ctxtVBAK-VBELN 4711       # one action

npm install --save-dev sap-ui-automation
npx sap-ui-automation init                # sap.config.ts, an example test, skills
npx sap-ui-automation test
```

[CLI for coding agents](docs/guides/cli-for-agents.md) ·
[Writing tests](docs/guides/sdk-tests.md) ·
[Recording and replay](docs/guides/record-replay.md) (export to
Playwright, VBScript, Gherkin or SAP Cloud ALM)

## Writes

`SAP_WRITE` in the server's environment decides what happens to an action
that may save, post or delete:

- `confirm` (the default): your client asks you before each write. Claude
  Code, VS Code and Codex can ask. Where the client cannot ask
  (headless runs such as `claude -p` or `codex exec`, and clients without
  the question, as listed in the link below) and in the `sap-gui` command
  line, every write is refused
  ([which clients can ask](docs/concepts/confirm-mode.md#which-clients-can-ask)).
- `off`: read-only. It was the default in 0.4 and earlier.
- `on`: writes run; your client's tool approval is the only check.

In Codex's Full Access mode (approvals set to never), Codex accepts the
question without showing it to you, so use `off` there. Use a test system
and a user with only the authorisations you want the agent to have
([safety model](docs/concepts/safety.md)).

## Status and limits

Version 0.5. It works on real ECC and S/4HANA systems, but parts are
young.

- **Experimental:** the network reader for SAP GUI without scripting.
  Record and replay have been checked live on Web GUI only.
- **Not supported:** SAP GUI for Java, Firefox, Safari, SNC-encrypted
  connections with the network reader.

Each guide ends with the limits of its surface.

## Documentation

The documentation site is
[docs.didro.ai/sap-ui-automation](https://docs.didro.ai/sap-ui-automation/);
the pages below are the guides behind it. Agents setting the server up
can follow [Setup steps for agents](docs/agent-setup.md).

- [Getting started](docs/getting-started/index.md) ·
  [Set up with your agent](docs/getting-started/setup-prompt.md) ·
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
- [Benchmarks](docs/benchmarks.md) ·
  [Security and data handling](docs/security.md) ·
  [FAQ and troubleshooting](docs/faq.md) ·
  [Comparison](docs/comparison.md)

Online at [docs.didro.ai/sap-ui-automation](https://docs.didro.ai/sap-ui-automation/).
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
