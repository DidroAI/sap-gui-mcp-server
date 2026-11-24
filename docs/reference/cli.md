# CLI commands

The package installs one command, `sap-ui-automation`. Without arguments it
is the MCP server on stdio; with a command it does one job and exits.

```sh
npx -y sap-ui-automation <command> [options]
# or, after npm i -g sap-ui-automation:
sap-ui-automation <command> [options]
```

| Command | Does | Exit code |
| --- | --- | --- |
| (none) | starts the stdio MCP server: what MCP clients run | runs until the client closes it |
| [`setup`](#setup) | adds the server to the MCP clients found on this machine | 0 |
| `init`, `install`, `test`, `show-trace`, agent CLI | see the table below | |
| [`doctor`](#doctor) | checks what the server can reach, and says what to change | 0 ready, 1 not ready |
| [`sessions`](#sessions) | lists the SAP sessions found now | 0; 1 when every surface failed |
| [`replay`](#replay) | runs recorded tests on an open session, with no model | 0 all passed, 1 otherwise |
| [`export`](#export) | writes a recorded test in another format | 0 |
| `--help`, `-h`, `help` | the usage and the main settings | 0 |
| `--version`, `-v` | the version | 0 |

An unknown command prints the usage and exits with 2. An error (a missing
file, a bad flag) prints its message and exits with 1.

Settings are environment variables, the same for the server and the
commands: [Configuration](configuration.md). `doctor`, `sessions` and
`replay` use `SAP_SURFACES`, `SAP_GUI_METHOD`, `SAP_CHROME_CDP`,
`SAP_ALLOW_SYSTEMS` and the other settings as the server would.

The program is also installed as `sap-gui`. With the SDK and the test
runner come these commands, described in their guides:

| Command | Does | Guide |
| --- | --- | --- |
| `init [--yes] [--force] [--dry-run]` | sets a project up: `sap.config.ts`, `sap-tests/example.sap.ts`, agent skills, MCP clients, `.gitignore` | [Writing tests](../guides/sdk-tests.md) |
| `install --skills [--target claude\|codex\|cursor\|all] [--global] [--dry-run]` | copies the bundled agent skills | [CLI for coding agents](../guides/cli-for-agents.md) |
| `test [files] [--config f] [--project p] [--reporter list,junit,json,html] [--grep re] [--retries n] [--list] [--update-locks]` | runs `*.sap.ts` tests | [Writing tests](../guides/sdk-tests.md) |
| `show-trace <file> [--out <file.html>] [--open]` | writes a recording or trace as one HTML page | [Trace viewer](../guides/trace-viewer.md) |
| `sessions`, `look`, `act`, `use`, `screenshot`, `record`, `daemon` | the agent CLI | [CLI for coding agents](../guides/cli-for-agents.md) |

## The server

```sh
sap-ui-automation
```

Starts the MCP server on stdin and stdout. MCP clients run this; you do not
normally run it yourself. It reads its settings once, at start. It stops
when the client closes stdin, or on SIGINT or SIGTERM, and then disconnects
from Chrome without closing it.

## setup

```sh
sap-ui-automation setup [claude-code|codex|claude-desktop|cursor|windsurf|vscode]... [--dry-run]
```

Adds the server, as `sap-ui-automation`, to the MCP clients it finds:

| Client | How | Found when |
| --- | --- | --- |
| Claude Code | `claude mcp add sap-gui --scope user -- <command>` | the `claude` command is on the PATH |
| Codex | a `[mcp_servers.sap-ui-automation]` table in `~/.codex/config.toml` (`$CODEX_HOME/config.toml`) | the `codex` command is on the PATH, or the folder exists |
| Claude Desktop | an `mcpServers["sap-ui-automation"]` entry in `claude_desktop_config.json` | its folder exists (macOS: `~/Library/Application Support/Claude`; Windows: `%APPDATA%\Claude`) |
| Cursor | an `mcpServers["sap-ui-automation"]` entry in the project's `.cursor/mcp.json` when that file exists, else in `~/.cursor/mcp.json` | one of those exists |
| Windsurf (Devin Desktop) | an `mcpServers["sap-ui-automation"]` entry in `~/.config/devin/mcp_config.json` (`$XDG_CONFIG_HOME/devin`; Windows: `%APPDATA%\devin`) | that folder or `~/.codeium/windsurf` exists |
| VS Code (Copilot) | a `servers["sap-ui-automation"]` entry in the project's `.vscode/mcp.json` | that file exists, or `vscode` is named |

| Option | Effect |
| --- | --- |
| `claude-code`, `codex`, `claude-desktop`, `cursor`, `windsurf`, `vscode` | only these clients; default every one found |
| `--dry-run` | say what would change, change nothing |

- It never overwrites an existing `sap-ui-automation` entry.
- It keeps a `.bak` copy of a file before it changes it.
- The command it writes depends on how it was started: `npx -y
  sap-ui-automation` when run through `npx`, `sap-ui-automation` when
  installed on the PATH, else Node with the path of the script. On Windows
  it is wrapped in `cmd /c`.
- When it finds no client, it prints the command to add by hand.
- It adds no settings: the server starts with `SAP_WRITE=off`. Add
  variables in the client's configuration.

## doctor

```sh
sap-ui-automation doctor
```

Checks what the server can reach on this machine, one block per area, a
mark per check (`✓` or `✗`), and the one thing to do when a check fails.
It ends with `Ready.` or `Not ready yet: fix the ✗ above, then run doctor
again.`

| Area | Checks |
| --- | --- |
| SAP GUI for Windows (scripting) | PowerShell may run the host; SAP GUI is running; scripting is on in SAP GUI; scripting is allowed on the SAP system; the two "notify" options are off |
| SAP GUI for Windows (`SAP_GUI_METHOD=diag`) | the local router listens; connections go through it; decoding (bytes lost, what was not read, SNC); the router's messages |
| Chrome: Web GUI and Fiori | Chrome reachable, its version, `SAP_ALLOW_ORIGINS`, open tabs; the Web GUI and Fiori tabs found |

On a machine other than Windows, SAP GUI for Windows is listed as not
checked. If Chrome asks whether to allow remote debugging, click Allow.

Every failed check, its cause and its fix: [FAQ and troubleshooting](../faq.md).

## sessions

```sh
sap-ui-automation sessions
```

Lists the SAP sessions the server finds now, in the format of the
`sap_sessions` tool ([MCP tools](tools.md#sap-sessions)), then exits.
Problems of a surface (SAP GUI scripting off, no Chrome) go to stderr. It
exits with 1 only when every surface failed: that is a setup problem, not
"nothing open".

## replay

```sh
sap-ui-automation replay <file>... [--var name=value]... [--session <ref>] [--loose] [--continue] [--stay] [--json] [--junit <file>]
```

Runs recorded tests (`.saptest.json`) on a session you have open, with no
model, under the same guard as `sap_act`. It never logs on.

| Option | Effect |
| --- | --- |
| `<file>...` | one or more recordings. Several run in order on one session; each hands its variables, captured ones included, to the next. The run stops at the first test that fails |
| `--var name=value` | a value for a test variable; repeat for several. A name no test has is an error |
| `--session <ref>` | the session: number, id, system, transaction or surface, as in `sap_use`. Default: the first one found |
| `--loose` | landing on another screen than recorded is a note, not a failure |
| `--continue` | on a screen with a choice the recording does not have (availability control), press its neutral Continue and say so |
| `--stay` | after a failure, stay on the failing screen. Default: leave the transaction with `/n` (unsaved input is dropped) |
| `--json` | the results as JSON |
| `--junit <file>` | also write JUnit XML: one suite per test, one case per step |

A step that may write needs `SAP_WRITE=on`. Guide:
[Recording and replay](../guides/record-replay.md).

## export

```sh
sap-ui-automation export <file> --to <target> [--out <file>]
```

Writes one recording in another format.

| Target | File | For |
| --- | --- | --- |
| `calm` | `.calm.json` | SAP Cloud ALM manual test case, as the input of a Cloud ALM MCP server's `calm_create_test_case` tool |
| `vbs` | `.vbs` | SAP GUI scripting (VBScript), for SAP GUI for Windows |
| `playwright` | `.spec.ts` | Playwright test for Web GUI (`@playwright/test`) |
| `playwright-sap` | `.psap.spec.ts` | Playwright test with playwright-sap's `locateSID` |
| `gherkin` | `.feature` | Gherkin feature (Given / When / Then step list) |

| Option | Effect |
| --- | --- |
| `--to <target>` | required: one of the targets above |
| `--out <file>` | where to write. `-` prints to stdout. Default: next to the recording, with the target's suffix in place of `.saptest.json` |

It prints the path written.
