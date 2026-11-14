# sap-gui-mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets an agent (Claude,
Codex, Cursor…) **see and drive the SAP screens you already have open**:

- **SAP GUI for Windows**, through SAP GUI scripting;
- **SAP GUI for HTML (Web GUI)** in Chrome;
- **SAP Fiori** in Chrome, including Web GUI apps opened inside the launchpad.

It finds your sessions by itself and works in them as you, under your
authorisations. It never logs on and never stores a password.

> Status: in development, not on npm yet. MIT licence.

## Why another SAP GUI server

Generic browser tools and screenshots were not built for SAP screens:

- they miss checkbox states and SAP's own ids;
- they lose the label next to each field;
- they spend most of their tokens on layout tables.

The existing SAP GUI MCP servers use scripting, but drop most of the
screen: tree nodes, ALV grid cells, table controls, and popups with what is
behind them.

This server reads the screen the way SAP models it and prints one line per
control:

```
TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM ABA (800)
WINDOW wnd[0]  "Create Sales Order: Initial Screen"
okcd  command-field
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
boxTEXT  group  Organizational Data
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
ctxtVBAK-VTWEG  field  Distribution Channel = ""  (edit)
ctxtVBAK-SPART  field  Division = ""  (edit)
mbar  menubar  Sales document {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, ...
```

(Web GUI, transaction VA01; SAP's messages appear as a `wnd[0]/sbar  status`
line.)

The agent acts on those ids with one small set of JSON actions, the same on
every surface.

First measurements, from our own probe: SAP demo systems, ten screens per
surface, one model-chosen action per test, one run. The method and scripts
will be published with the benchmark. The compact view saw:

| Surface | Screen content seen | Tokens, ten screens | Actions that worked |
| --- | --- | --- | --- |
| Web GUI | 100% (Playwright MCP: 100%) | 20k (Playwright MCP: 203k) | 6 of 6 |
| SAP GUI for Windows | 99% (best other SAP GUI MCP: 53%) | 24k | 5 of 5 that scripting can reach |
| Fiori (S/4HANA launchpad) | 99% | 35k (Playwright MCP: 101k) | 6 of 7 |

The other servers' labels and checkbox states were the weak point:
Playwright MCP paired 66% of labels with their values on Web GUI and showed
no checkbox state. These numbers come from a small internal probe, not a
benchmark yet. A public, repeatable benchmark is on the way, with whole
tasks, held-out screens, and Claude's and Codex's own computer-use tools.

## Quick start

Requires Node 22 or later.

```sh
claude mcp add sap-gui --scope user -- npx -y sap-gui-mcp-server
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.sap-gui]
command = "npx"
args = ["-y", "sap-gui-mcp-server"]
```

Claude Desktop, Cursor and other clients take the same command:
`npx -y sap-gui-mcp-server`. On Windows, some clients need it as
`cmd /c npx -y sap-gui-mcp-server`.

Then open SAP and ask: *"Look at my SAP screen and tell me which fields are
required"*, or *"In VA03, open order 19097 and tell me its delivery
status"*.

Check your setup at any time:

```sh
npx -y sap-gui-mcp-server doctor     # what the server can reach, and what to change
npx -y sap-gui-mcp-server sessions   # the SAP sessions it finds right now
```

> Not on npm yet. Until it is, build from a checkout (`bun install && bun
> run build && npm link`) and use `sap-gui-mcp-server` instead of
> `npx -y sap-gui-mcp-server`.

## How it finds your sessions

**SAP GUI for Windows** (when the server runs on Windows). SAP GUI scripting
lists every open connection and session, with system, client, user and
transaction. The server uses the active one; the agent can switch. Two
settings must allow it, and `doctor` checks both:

- **Scripting on in SAP GUI:** SAP GUI options → Accessibility & Scripting →
  Scripting → *Enable scripting*. Untick *Notify when a script attaches to
  SAP GUI*, or SAP GUI asks you each time.
- **Scripting allowed on the SAP system:** profile parameter
  `sapgui/user_scripting = TRUE`, set by your SAP basis team. Test and QA
  systems often allow it; production systems often do not.

Nothing else is installed: the server talks to SAP GUI through Windows
PowerShell, which comes with Windows.

**Web GUI and Fiori in Chrome.** The server attaches to the Chrome you are
using, in this order:

1. `SAP_CHROME_CDP`, if you set it, e.g. `http://127.0.0.1:9222`. Nothing
   else is tried then;
2. your running Chrome, once you allow it: open
   `chrome://inspect/#remote-debugging` and tick *Allow remote debugging*.
   This needs Chrome 144 or later; Chrome asks you to confirm when the
   server connects. Chrome stable is tried first, then Chrome beta, then
   Microsoft Edge.

The server does not attach to port 9222 by itself: a browser listening
there may belong to another tool. To use a Chrome started with
`--remote-debugging-port`, name it with `SAP_CHROME_CDP`. Since Chrome 136
that switch only opens the port together with `--user-data-dir`, pointing
to a directory other than Chrome's default one:

```sh
chrome --remote-debugging-port=9333 --user-data-dir="$HOME/chrome-sap"
SAP_CHROME_CDP=http://127.0.0.1:9333 npx -y sap-gui-mcp-server sessions
```

Each tab has one owner, decided in one place:

- **Web GUI:** the address path contains `/sap/bc/gui/sap/its/webgui`, or
  the page holds Web GUI's own controls;
- **Fiori:** SAPUI5 runs in the page, and it is a launchpad: an address
  under `/sap/` (`/sap/bc/ui2/flp`), or the launchpad shell (`sap.ushell`)
  in the page;
- any other tab is left alone. Only `http` and `https` pages are looked
  at, never `chrome://` pages or extensions.

Remote debugging gives the server (and so the agent using it) access to
every tab of that browser, not only SAP tabs. The server only reads tabs it
recognises as SAP, but consider a separate Chrome profile for SAP work.
Set `SAP_ALLOW_ORIGINS` to look only at your SAP hosts. The server reads
system, client and user from the page, and `sap_sessions` shows each tab's
origin. Chrome does not tell a tab's position, so tabs are named by their
title. Closing the server never closes your browser.

## Tools

| Tool | Does |
| --- | --- |
| `sap_sessions` | lists the SAP sessions open on this machine; `*` marks the active one |
| `sap_use` | makes another session the active one: by number, id, system, transaction, or surface (`fiori`, `webgui`, `sapgui`) |
| `sap_look` | the screen as compact text; `full: true` for every id and column |
| `sap_act` | one action, then the new screen |
| `sap_confirm` | runs an action held for your confirmation, when your client cannot ask you itself (see below) |
| `sap_screenshot` | a PNG of the window or tab, for charts and visual checks |
| `sap_record` | records the run as a test: start, stop, checks, variables, export |
| `sap_replay` | runs a recorded test again, with no model |

Actions (`sap_act`):

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
{"do": "press", "id": "btn[8]"}
{"do": "key", "key": 0}
{"do": "select", "id": "tabpT\\08"}
{"do": "check", "id": "chkFLAG", "value": true}
{"do": "combo", "id": "cmbTYPE", "key": "PROG"}
{"do": "okcode", "value": "/nVA03"}
{"do": "f4", "id": "ctxtVBAK-VKORG"}
{"do": "dblclick", "id": "lbl[1,13]"}
{"do": "tree", "id": "shell", "node": "  4", "how": "double"}
{"do": "grid", "id": "cntlGRID1/shellcont/shell", "row": 0, "col": "VBELN", "how": "double"}
```

For `key`, 0 is Enter, 3 Back, 4 F4, 8 F8, 11 Save and 12 Cancel; a key
is a number from 0 to 99 or a key name (`Enter`, `Escape`, `Shift+Tab`,
`Control+S`). Fiori also takes `click` and `scroll`.

The server brings every action to one shape before anything reads it:
`do` must be one of the verbs above, a key must be a number or a known
name, and line breaks are removed from ids and values. The guard and the
surface then work from that same object.

The command field (`okcd`) takes commands through `{"do": "okcode"}` only.
`set`, `focus` or any other action on the field itself is refused, on
every surface, so that a command cannot go round the guard.

## Record a run as a test

An agent's run can be kept as a test and run again with no model:

```
sap_record {"op":"start","name":"VA03 display order"}
sap_act    {"action":{"do":"okcode","value":"/nVA03"}}       ... act as usual
sap_record {"op":"assert","check":"field","id":"txtVBAK-NETWR","equals":"2.500,00"}
sap_record {"op":"variable","name":"order","value":"19097"}
sap_record {"op":"stop"}
```

```sh
sap-gui-mcp-server replay sap-tests/va03-display-order.saptest.json --var order=4711
sap-gui-mcp-server export sap-tests/va03-display-order.saptest.json --to calm   # or vbs, playwright, playwright-sap, gherkin
```

- The recording is one JSON file: each action, the screen it led to, the
  status bar, the checks you marked, and variables for values that change.
- `replay` runs it on a session you have open, under the same guardrails as
  `sap_act`, and reports pass or fail per step with the screen at the
  failure. `sap_replay` does the same from the agent.
- `export` writes a SAP Cloud ALM manual test case, a SAP GUI script (VBS), a
  Playwright spec for Web GUI, or a Gherkin step list.

Recordings go to `SAP_RECORD_DIR` (default `./sap-tests`) and hold the values
that were typed. Design, file format and limits: [docs/record.md](docs/record.md).
Prototype: checked on Web GUI; not yet run on SAP GUI for Windows or Fiori.

## Guardrails

The server enforces these whatever the agent decides:

| Setting | Effect |
| --- | --- |
| `SAP_WRITE=off` (default) | actions that may write to SAP are refused: Save, Post, Delete, Release, Approve, "Yes" on a save popup |
| `SAP_WRITE=confirm` | such actions are held for your yes (see "Confirm mode") |
| `SAP_WRITE=on` | such actions run |
| `SAP_ALLOW_SYSTEMS=ABA/800,S4H` | only these systems, optionally with a client, are visible and usable. Checked on every tool, each time: a session that moves to another system is refused from then on |
| `SAP_ALLOW_ORIGINS=https://myhost:44300` | only browser tabs of these origins are looked at (comma list) |
| `SAP_ALLOW_TCODES=VA03,MM03` | the agent may open and work in only these transactions |
| `SAP_BLOCK_TCODES=SE38,SM30` | the agent may not open or work in these transactions |

The transaction lists apply to commands (`/nSE38`, `/oSE38`, `/*SE38`) and
to the transaction the session is in. A menu entry, a favourite or a
double-click in a tree can open a transaction without a command: the
server reads the transaction before and after each action. If an action
lands in a transaction the lists refuse, the server says so and leaves it
with `/n`. If the session is already in one, only a command that leaves it
is accepted. `/nex`, `/nend` and `/i` close sessions; they are not
transactions, and the surface's own rules decide on them. On Fiori the
"transaction" is the app's intent (such as `SalesOrder-display`), and the
lists compare against that; a Web GUI app inside the launchpad is not
checked by its transaction code.

Each surface classifies an action before it runs:

- **read:** value help, expanding a tree node;
- **navigate:** typing, Enter, tabs, Back, Execute (F8);
- **commit:** anything that may save, and anything not known to be safe.

The rule fails closed. A button, menu entry, function key or function code
is a commit unless it is known to be safe: by its key (Enter, Back,
Cancel, F4, paging...), its function code, or its text. Commit words are
known in English, German, French, Spanish, Portuguese, Italian and Dutch.
Safe words are known in English, German, French and Spanish. In another
logon language, only ids, keys and function codes count as safe, so more
actions are held. Enter or Space on a focused button counts as pressing
that button. Typing works only in fields, never on buttons. `/nex`,
`/nend` and `/i` count as commits, because they close sessions and drop
unsaved data. Password fields cannot be typed into, and nothing runs on a
logon screen: log on yourself.

**Execute (F8)** counts as navigate on purpose. It runs reports and lists
(VA05, ME2N...), which read. A report that updates the database usually
has a test-run flag and asks before posting, but not always. Put known
update programs in `SAP_BLOCK_TCODES`.

A slow action can be given more time with `"timeout"` in seconds, up to
600, for example `{"do":"key","key":8,"timeout":300}` (SAP GUI).

### Confirm mode

With `SAP_WRITE=confirm`, an action that may write is held until you say
yes. How you are asked depends on your MCP client:

- **The client supports MCP elicitation:** the server asks you in the
  client itself, with the action, the system, the transaction and the
  window title. The action runs only if you accept. The agent cannot
  answer for you.
- **It does not:** `sap_act` answers with a token, the agent asks you in
  the chat, then calls `sap_confirm` with the token. This is **advisory**:
  the server cannot check that you were asked. Treat it as a reminder to
  the agent, not as a control. If you need a control, use `SAP_WRITE=off`
  or a client with elicitation.

In both cases the confirmation is bound to what was shown: the session,
system, client, transaction, window title, the action and what the server
said it would do. Before running, the server reads the screen again and
refuses if any of these changed. A token works once and for ten minutes.

This is a safety net, not a guarantee. A custom button whose name is on the
safe list can still write, and so can a report started with F8. Use a test system and
a user with the authorisations you want the agent to have.

Other settings:

| Setting | Effect |
| --- | --- |
| `SAP_SURFACES=sapgui,webgui,fiori` | which kinds of session to look for |
| `SAP_FIORI_WAIT=busy` | faster Fiori waits (busy indicators only) |
| `SAP_RECORD_DIR=./sap-tests` | where recordings and exports are written |
| `SAP_RECORD=on` | record every session from its first action |

## Limits

- **SAP GUI:**
  - SAP GUI for Java (macOS, Linux) has no scripting: on a Mac, use Web
    GUI or Fiori.
  - HTML panels inside SAP GUI (such as SE80's object selector) cannot be
    reached by scripting; use `sap_screenshot` to see them.
- **Browsers:** Chrome is supported; Microsoft Edge (also Chromium) is
  found the same way and is likely to work; Firefox and Safari are not.
- **Long lists:** these show the rows on screen, with the total count.

## Development

```sh
bun install
bun run typecheck && bun test && bun run build
node dist/cli.js doctor
```

`test/dev/webgui-logon.ts` and `test/dev/fiori-logon.ts` log a
throwaway Chrome on to a test system for live checks. They read the
password from a file and never print it.

## Licence

MIT. SAP, SAP GUI, SAP Fiori and SAPUI5 are trademarks of SAP SE. This
project is not affiliated with SAP.
