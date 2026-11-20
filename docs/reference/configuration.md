# Configuration

Every setting is an environment variable of the server process. Set it in
your MCP client's `env` block, or in the shell before a CLI command:

```sh
claude mcp add sap-gui --scope user -e SAP_WRITE=confirm -- npx -y sap-gui-mcp-server
SAP_ALLOW_SYSTEMS=ABA/800 npx -y sap-gui-mcp-server sessions
```

A value the server cannot read (`SAP_WRITE=yes`, an unknown surface, an
origin that is not `http` or `https`) is an error with a message that
names the variable. `SAP_WRITE`, `SAP_ALLOW_LOGOFF`, `SAP_SURFACES`,
`SAP_VIEW` and `SAP_RECORD` are read when the server starts: a wrong value
there stops it.

Lists are separated by commas or spaces and are not case-sensitive.

## Safety

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_WRITE` | `off` | `off`, `confirm`, `on` | what happens to actions that may write to SAP: refused, held for your yes, or run. See [Safety model](../concepts/safety.md) and [Confirm mode](../concepts/confirm-mode.md) |
| `SAP_ALLOW_SYSTEMS` | all | `ABA/800,S4H` | only these systems, optionally with a client, are visible and usable. Checked on every tool call: a session that moves to another system is refused from then on |
| `SAP_ALLOW_TCODES` | all | `VA03,MM03` | the only transactions the agent may open or work in. On Fiori, app intents (`SalesOrder-display`) |
| `SAP_BLOCK_TCODES` | none | `SE38,SM30` | transactions the agent may not open or work in |
| `SAP_ALLOW_ORIGINS` | all | `https://myhost:44300` | only browser tabs of these origins are looked at |
| `SAP_ALLOW_LOGOFF` | `off` | `off`, `on` | `on`: the agent may end sessions or the logon (`/nex`, `/nend`, `/i`, Log Off, Yes on the Log Off popup). Off also with `SAP_WRITE=on` |

## Where the server looks

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_SURFACES` | `sapgui,webgui,fiori` on Windows, `webgui,fiori` elsewhere | any of `sapgui`, `webgui`, `fiori` | which kinds of session to look for. Lower case |
| `SAP_GUI_METHOD` | scripting | `diag` | `diag` reads SAP GUI for Windows from its network traffic instead of scripting (experimental). Any other value means scripting. See [Network reader](../guides/network-reader.md) |
| `SAP_CHROME_CDP` | the running Chrome, then Chrome Beta, then Edge, that allows remote debugging | `http://127.0.0.1:9333` | a Chrome DevTools endpoint (`http`, `https`, `ws` or `wss`). Nothing else is tried when it is set. See [Chrome](../guides/chrome.md) |

## Network reader (`SAP_GUI_METHOD=diag`)

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_DIAG_PORT` | `3298` | a port | where the local SAProuter listens, on `127.0.0.1`. Put `/H/127.0.0.1/S/<port>` at the start of the connection's SAProuter string in SAP Logon |
| `SAP_DIAG_CELL` | from the traffic | `cw,ch[,x0,y0]` | the pixel size of SAP GUI's character cell, and the offset of the first one in the screen area. Set it when clicks miss on a theme or a display scaling. `cw` at least 3, `ch` at least 6 |
| `SAP_DIAG_REQUEST_MS` | `3000` | milliseconds | how long to wait for SAP GUI to send a request after a key or a click, before the answer says the input may have missed |
| `SAP_DIAG_QUIET_MS` | `60` | milliseconds | how long the traffic must be quiet after SAP's answer before an action ends |
| `SAP_DIAG_CAPTURE` | off | a folder | keeps a copy of the raw traffic, to debug the decoder. It holds everything SAP GUI sent and received, your logon included. The file is created readable by its owner only, where the system allows it. Keep it local and delete it after use |

## Answers and waits

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_VIEW` | `diff` | `diff`, `full` | `full`: every action answers with the whole screen. `diff`: only what changed, when the screen is the same and the changes are shorter |
| `SAP_FIORI_WAIT` | full waits | `busy` | faster Fiori waits: busy indicators only, without UI5's RecordReplay |
| `SAP_CODE` | on | `off` | `off`: `sap_act` and `sap_confirm` answers end without the `code:` line (the SDK call that repeats the action) |
| `SAP_TIMINGS` | off | `on`, `true`, `1` | every `sap_act` answer adds a line that says where the time went. One action can ask with `"timing": true` |

## Recording and files

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_RECORD_DIR` | `./sap-tests` (in the server's working directory) | a folder | where `sap_record` writes recordings and exports |
| `SAP_RECORD` | `off` | `off`, `on` | `on`: record every session from its first action, without `sap_record start` |
| `SAP_DOWNLOAD_DIR` | `downloads` in `SAP_RECORD_DIR` when that is set, else `./sap-downloads` | a folder | Web GUI: where a file SAP writes "to a local file" (List > Export > Local File) is copied. Web GUI keeps such a file inside the browser; the action's answer names the copy |

Recordings hold the values that were typed: treat them like the system's
data.

## Agent CLI

| Variable | Default | Effect |
| --- | --- | --- |
| `SAP_CLI_DIR` | `.sap-gui/screens` | where the agent CLI writes answers and screens |
| `SAP_CLI_IDLE` | `30` | minutes without a command before the daemon exits |
| `SAP_CLI_SESSION` | one daemon per directory | a name: one daemon for every directory that sets it |

See [CLI for coding agents](../guides/cli-for-agents.md).

## Read by exported tests, not by the server

The Playwright specs that `export --to playwright` writes read these when
they run. The server itself never reads a password.

| Variable | Effect |
| --- | --- |
| `SAP_WEBGUI_URL` | the Web GUI address the spec logs on to |
| `SAP_FIORI_URL` | the launchpad address, for a Fiori recording |
| `SAP_USER`, `SAP_PASSWORD` | the user and password the spec logs on with |
| `SAP_VAR_<NAME>` | the value of the test's variable `<name>` (upper case) |

## Other variables the server reads

These are standard variables of the operating system or of other tools.
You do not normally set them for this server.

| Variable | Used for |
| --- | --- |
| `LOCALAPPDATA` (Windows), `XDG_CONFIG_HOME`, `CHROME_CONFIG_HOME` (Linux) | where Chrome's profile, and so its `DevToolsActivePort` file, is |
| `SystemRoot`, `windir` | the path to Windows PowerShell (`powershell.exe`) |
| `APPDATA` | `setup`: where Claude Desktop's config is on Windows |
| `CODEX_HOME` | `setup`: where Codex's `config.toml` is (default `~/.codex`) |

## For development only

| Variable | Effect |
| --- | --- |
| `SAP_SCREEN_DEBUG` | network reader: a folder where the Windows input host saves the image it reads cell sizes from (`sheet.png`) |
| `SAP_TEST_CHROME` | the repository's tests: a Chrome to run browser tests against |

`sap-gui-mcp-server --help` lists the commands and the main settings
([CLI commands](cli.md)).
