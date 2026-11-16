# sap-gui-mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets an agent (Claude,
Codex, Cursor and other MCP clients) **see and drive the SAP screens you
already have open**:

- **SAP GUI for Windows**, through SAP GUI scripting (or, experimental,
  without scripting, by reading SAP GUI's network traffic);
- **SAP GUI for HTML (Web GUI)** in Chrome;
- **SAP Fiori** in Chrome, including Web GUI apps opened inside the
  launchpad.

It finds your open sessions by itself and works in them as you, under your
SAP authorisations. It never logs on and never stores a password. Actions
that may write to SAP are refused unless you allow them.

> Status: 0.1.0, the first public version. It works on real systems, but
> parts are young: see [Limits](#limits). MIT licence.

## What the agent sees

The server reads the screen the way SAP models it and prints one line per
control, with SAP's own ids, the label next to each field, its value and
whether it can be edited:

```
TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM ABA (800)
WINDOW wnd[0]  "Create Sales Order: Initial Screen"
okcd  command-field
btn[3]  button  Back (F3)
btn[8]  button  Create with Reference (F8)
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
boxTEXT  group  Organizational Data
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
ctxtVBAK-VTWEG  field  Distribution Channel = ""  (edit)
ctxtVBAK-SPART  field  Division = ""  (edit)
mbar  menubar  Sales document {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, ...
```

(Web GUI, transaction VA01; SAP's messages appear as a `sbar  status`
line.) Checkbox states, tree nodes, ALV grid cells, table controls and
popups, with what is behind them, are all part of the view.

The agent acts on those ids with one small set of JSON actions, the same on
every surface. After an action that leaves it on the same screen, it gets
only what changed:

```
set wnd[0]/usr/ctxtVBAK-VKORG

CHANGED 1 of 18 lines (same screen; sap_look shows all of it):
~ ctxtVBAK-VKORG  field  Sales Organization = "1000"  (edit)
```

On one read-only flow of 51 steps on Web GUI (VA01 without saving, VA03,
VA05, SE16N, SE16, MM03; `test/dev/soak.ts`, one run, tokens counted with
the Anthropic `count_tokens` API), the answers cost 58k tokens in all, and
73k with `SAP_VIEW=full`, where every action answers with the whole screen.
Typing into a field answers with about 50 tokens instead of the screen.

## Requirements

- **Node.js 22 or later** on the machine where your MCP client runs.
- At least one of these, depending on how you use SAP:

| Surface | You need |
| --- | --- |
| SAP GUI for Windows | Windows, SAP GUI for Windows, scripting enabled in SAP GUI **and** allowed on the SAP system ([details](#sap-gui-for-windows)) |
| SAP GUI for Windows without scripting (experimental) | Windows, SAP GUI for Windows, a connection entry you can edit in SAP Logon, no SNC encryption ([details](#sap-gui-without-scripting-experimental)) |
| Web GUI | Chrome 144 or later (or Edge) with remote debugging allowed, and a Web GUI tab open and logged on: its address contains `/sap/bc/gui/sap/its/webgui` ([details](#web-gui-and-fiori-in-chrome)) |
| Fiori | The same Chrome, and a Fiori launchpad tab open and logged on (for example `/sap/bc/ui2/flp`) |

Web GUI and Fiori work from Windows, macOS and Linux. SAP GUI for Java
(macOS, Linux) has no scripting and is not supported.

## Install

Most MCP clients start the server with `npx`, so nothing needs installing
first:

```sh
npx -y sap-gui-mcp-server --help
```

Or install it once and use the `sap-gui-mcp-server` command:

```sh
npm i -g sap-gui-mcp-server
```

### Let the server configure your clients

`setup` adds the server to every MCP client it finds (Claude Code, Codex,
Claude Desktop). It never overwrites an existing `sap-gui` entry and keeps a
`.bak` of any file it changes:

```sh
npx -y sap-gui-mcp-server setup --dry-run   # what it would change
npx -y sap-gui-mcp-server setup             # or: setup claude-code | codex | claude-desktop
npx -y sap-gui-mcp-server doctor            # what the server can reach, and what to change
npx -y sap-gui-mcp-server sessions          # the SAP sessions it finds right now
```

You can also paste the prompt in [docs/setup-prompt.md](docs/setup-prompt.md)
into Claude Code or Codex: the agent runs these commands, walks you through
each setting `doctor` asks for, then looks at your SAP screen to prove it
works.

### Or configure them by hand

Each snippet starts the server with writes off. Add settings from
[Configuration](#configuration) as environment variables.

**Claude Code**

```sh
claude mcp add sap-gui --scope user -- npx -y sap-gui-mcp-server
# with a setting:
claude mcp add sap-gui --scope user -e SAP_WRITE=confirm -- npx -y sap-gui-mcp-server
```

Or install it as a Claude Code plugin, which also brings the
[`sap-gui-drive` skill](skills/sap-gui-drive/SKILL.md):

```
/plugin install sap-gui --marketplace DidroAI/sap-gui-mcp-server
```

**Claude Desktop** (`claude_desktop_config.json`: Settings → Developer →
Edit Config):

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

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.sap-gui]
command = "npx"
args = ["-y", "sap-gui-mcp-server"]

[mcp_servers.sap-gui.env]
SAP_WRITE = "off"
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project):

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

On Windows, some clients cannot start `npx` directly: use
`"command": "cmd", "args": ["/c", "npx", "-y", "sap-gui-mcp-server"]`
(`setup` does this for you).

Then open SAP and ask, for example: *"Look at my SAP screen and tell me
which fields are required"*, or *"In VA03, open order 19097 and tell me its
delivery status"*.

## How it finds your sessions

### SAP GUI for Windows

When the server runs on Windows, SAP GUI scripting lists every open
connection and session, with system, client, user and transaction. The
server uses the active one; the agent can switch. Two settings must allow
it, and `doctor` checks both:

- **Scripting on in SAP GUI:** SAP GUI options → Accessibility & Scripting →
  Scripting → *Enable scripting*. Untick *Notify when a script attaches to
  SAP GUI* and *Notify when a script opens a connection*, or SAP GUI asks
  you each time.
- **Scripting allowed on the SAP system:** profile parameter
  `sapgui/user_scripting = TRUE`, set by your SAP basis team. Test and QA
  systems often allow it; production systems often do not.

Nothing else is installed: the server talks to SAP GUI through Windows
PowerShell, which comes with Windows.

### SAP GUI without scripting (experimental)

When scripting is off, the server can read SAP GUI from the traffic between
SAP GUI and the SAP system (SAP's DIAG protocol) instead:

1. Set `SAP_GUI_METHOD=diag` in the server's environment. The server then
   runs a SAProuter on `127.0.0.1:3298` (`SAP_DIAG_PORT` to change it).
2. In SAP Logon, edit the connection entry: put `/H/127.0.0.1/S/3298` at the
   start of its SAProuter string (before your company's router, if there is
   one), and log on again.

The server passes the traffic on unchanged and decodes a copy: the screen as
SAP sent it, with SAP's field names, every row of tables, grids and lists,
and tree nodes. Nothing is loaded into SAP GUI. It acts with the keyboard and
the mouse, at the place SAP gave each field, so SAP GUI's window must be on
the screen, and a typed value reaches SAP (and the view) with the next Enter
or function key. It cannot read connections encrypted with SNC. The server
must be running before you log on, since SAP GUI connects through it.

### Web GUI and Fiori in Chrome

The server attaches to the Chrome you are using, in this order:

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
recognises as SAP, but consider a separate Chrome profile for SAP work, and
set `SAP_ALLOW_ORIGINS` to look only at your SAP hosts. The server reads
system, client and user from the page, and `sap_sessions` shows each tab's
origin. Chrome does not tell a tab's position, so tabs are named by their
title. Closing the server never closes your browser.

## Tools

| Tool | Does |
| --- | --- |
| `sap_sessions` | lists the SAP sessions open on this machine; `*` marks the active one |
| `sap_use` | makes another session the active one: by number, id, system, transaction, or surface (`fiori`, `webgui`, `sapgui`) |
| `sap_look` | the screen as compact text; `full: true` for every id and column; `diff: true` for what changed since the last view; `id` for one control whole; `id` and `rows` for a range of rows of a long list, and `cols` for only some of its columns |
| `sap_act` | one action, then the new screen, or only what changed when the screen is the same one |
| `sap_confirm` | runs an action held for your confirmation, when your client cannot ask you itself (see [Confirm mode](#confirm-mode)) |
| `sap_screenshot` | a PNG of the window or tab, for charts and visual checks |
| `sap_record` | records the run as a test: start, stop, checks, variables, export |
| `sap_replay` | runs a recorded test again, with no model |

Actions (`sap_act`):

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
{"do": "press", "id": "btn[8]"}
{"do": "key", "key": 0}
{"do": "select", "id": "tabpT\\08"}
{"do": "select", "id": "tblSAPMV45ATCTRL_U_ERF_AUFTRAG", "row": 2}
{"do": "check", "id": "chkFLAG", "value": true}
{"do": "combo", "id": "cmbTYPE", "key": "PROG"}
{"do": "combo", "id": "cmbTYPE"}
{"do": "okcode", "value": "/nVA03"}
{"do": "f4", "id": "ctxtVBAK-VKORG"}
{"do": "dblclick", "id": "lbl[1,13]"}
{"do": "tree", "id": "shell", "node": "  4", "how": "double"}
{"do": "grid", "id": "cntlGRID1/shell", "row": 120, "col": "VBELN", "how": "double"}
{"do": "grid", "id": "cntlGRID1/shell", "col": "VBELN", "how": "select"}
{"do": "set", "id": "cntlGRID1/shell", "row": 0, "col": "SEATSOCC", "value": "12"}
{"do": "combo", "id": "critcol", "key": "T"}
{"do": "tree", "id": "shell", "node": "05 3 1", "col": "1"}
{"do": "scroll", "id": "cntlGRID1/shell", "to": 120}
{"do": "toolbar", "id": "cntlGRID1/shell", "button": "&MB_FILTER"}
{"do": "focus", "id": "ctxtVBAK-VKORG"}
```

For `key`, 0 is Enter, 3 Back, 4 F4, 8 F8, 11 Save and 12 Cancel; a key
is a number from 0 to 99 or a key name (`Enter`, `Escape`, `Shift+Tab`,
`Control+S`). `combo` without a key lists the dropdown's entries and
chooses nothing. `scroll` takes a row counted from 0, or `"next"`,
`"prev"`, `"first"`, `"last"`; a table control's columns scroll with
`"right"` and `"left"`. `select` with a `row` selects that row of a table
control or grid (`"value": false` deselects). `grid` takes `how`
`"double"`, `"select"` or `"cell"` (the cursor only), and without `row`
selects a column by its header; `tree` takes `"double"`, `"select"`,
`"expand"` or `"collapse"`. Enter on a question popup (Yes, No, Cancel
in its body) is refused with the answers listed: press the one you mean
by its id. Escape with a menu or a list open closes that only. `toolbar` presses a button of a control's
own toolbar (an ALV grid's, for example). Fiori also takes `click`.

On Fiori, `{"do": "open", "app": "#SalesOrder-manage"}` opens a launchpad
app by its intent: the part of the app's address after `#`, with
parameters if you need them (`"#SalesOrder-display?SalesOrder=4711"`).
The server sets the launchpad's hash, as a bookmark of the app does, so
the tab stays on the launchpad it is on and on its logon; a URL is
refused. Opening an app is navigation for the guard, and
`SAP_ALLOW_TCODES` and `SAP_BLOCK_TCODES` are checked against the intent
before it is opened. An intent that carries a function code for a
transaction (`DYNP_OKCODE`) counts as a write. When the user may not open
the app, the launchpad says so in a popup, and the answer holds it.
A tab at a launchpad address that shows no launchpad (SAP's logon
page, its page to change the password, a tab that does not answer) is
listed by `sap_sessions` with a title that says so; a look names the
page, and every action there is refused: the user has to finish it.
`key` `Back` presses the launchpad's back button and never leaves the
launchpad; `sap_look` with an `id` reads that one control whole (also
the part of a table below the fold; `rows` is not used on Fiori).

The server brings every action to one shape before anything reads it:
`do` must be one of the verbs above, a key must be a number or a known
name, and line breaks are removed from ids and values. The guard and the
surface then work from that same object.

The command field (`okcd`) takes commands through `{"do": "okcode"}` only.
`set`, `focus` or any other action on the field itself is refused, on
every surface, so that a command cannot go round the guard.

### What an answer holds

`sap_act` answers with a line that says what was done, then the screen.
When the action left the session on the same screen (same transaction,
program, screen number and windows) and the changes are clearly shorter
than the screen, the answer holds the changes only:

| Mark | Line |
| --- | --- |
| `~` | a line whose content changed, as it is now |
| `+` | a new line |
| `-` | a line that is gone |
| `=` | an unchanged line, for context: the control whose rows follow |

A control whose rows changed for the most part (a list that was scrolled)
is given whole. The whole screen is always sent on a new transaction, a
new screen or a new popup, and when the changes are not much shorter than
it. After a popup closes, the changes are counted from the view the agent
got before the popup, and the header says so. `sap_look` always shows the
whole screen; `"full": true` on `sap_act` does so for one action, and
`SAP_VIEW=full` for all of them.

### Ids and handles

The compact view shortens each scripting id to a handle: the last segment
when it is unique on the screen (`ctxtVBAK-AUART`), else the last segment
with as few earlier ones as make it unique (`cntlGRID1/shell`,
`cntlSPLITTER_CONTAINER/shellcont[1]/shell`, `tbar[1]/btn[3]`). A toolbar
button is `btn[N]`, and N is its function key: `btn[8]` is F8. Every
action takes a handle, a full id, or a field's SAP name (`VBAK-AUART`).

- An id that names several controls is refused with the list of them. The
  server does not pick one.
- An id that is not on the screen is refused. If the screen is not the one
  the agent saw last, the answer holds the screen it is on.

### What the compact view folds, and how to get it

Nothing the screen shows is left out without a way to get it:

| In the compact view | To get the rest |
| --- | --- |
| Buttons that differ only by their field (`Multiple selection` on a selection screen) share a line: `btn%_S{VBELN,AUART}_%_APP_%-VALU_PUSH` | one id per name in braces: `btn%_SVBELN_%_APP_%-VALU_PUSH` |
| A dropdown shows its current entry and the number of entries: `(31 options)` | `{"do":"combo","id":...}` without a key, or `sap_look` with the dropdown's `id` |
| A table control shows one line per row, with the cells that hold a value | `full: true` gives every cell with its id |
| A classic list shows one line per row, each cell with its column | cells are `lbl[col,row]`; `full: true` gives one line per cell |
| A grid names the columns that are empty in every row shown once, with their titles | `full: true` gives every cell |
| Behind a popup, the main window keeps values, checked boxes, the selected tab and the status bar | `full: true`; buttons and menus there cannot be used until the popup closes |
| A view longer than 20,000 characters cuts the rows of its longest controls, and says how many | `sap_look` with the control's `id`, or with `id` and `rows` |
| The menu bar is one line with the menus' names | Web GUI: `sap_look` with `id: "mbar"` lists every entry with its id |

### Long lists

A grid, a table control, a tree or a classic list shows the rows SAP has
drawn, and says how many there are:

```
cntlGRID1/shell  grid  93 rows; columns: VBELN=Sales Document | AUDAT=Doc. Date | ...
  row 0: 4711 | 02.01.2024 | ...
  ... 68 more rows (shown: 0 to 24; scroll for the others)
```

- `{"do":"scroll","id":"cntlGRID1/shell","to":60}` moves the list to a row
  (counted from 0), or by a page with `"next"` and `"prev"`, or to
  `"first"` and `"last"`. The answer says which rows are shown.
- `sap_look` with `"id": "cntlGRID1/shell", "rows": "30-59"` reads those
  rows, scrolling as far as needed (200 rows at most per call).
- A `grid` action on a row that is not drawn scrolls to it first. A row
  the list does not have is an error that says so.
- A table control and a classic list count their rows on the screen: after
  a scroll the view says where they are scrolled to (`first 60`), and cell
  ids still count from the first row on screen.

## Safety model

The server enforces these rules whatever the agent decides. They are a
safety net for an agent that makes mistakes, not a security boundary: see
[SECURITY.md](SECURITY.md) for what they do not protect against.

| Setting | Effect |
| --- | --- |
| `SAP_WRITE=off` (default) | actions that may write to SAP are refused: Save, Post, Delete, Release, Approve, "Yes" on a save popup |
| `SAP_WRITE=confirm` | such actions are held for your yes (see [Confirm mode](#confirm-mode)) |
| `SAP_WRITE=on` | such actions run |
| `SAP_ALLOW_SYSTEMS=ABA/800,S4H` | only these systems, optionally with a client, are visible and usable. Checked on every tool, each time: a session that moves to another system is refused from then on |
| `SAP_ALLOW_ORIGINS=https://myhost:44300` | only browser tabs of these origins are looked at |
| `SAP_ALLOW_TCODES=VA03,MM03` | the agent may open and work in only these transactions |
| `SAP_BLOCK_TCODES=SE38,SM30` | the agent may not open or work in these transactions |
| `SAP_ALLOW_LOGOFF=on` | the agent may end SAP sessions or the logon (`/nex`, `/nend`, `/i`, Log Off, Yes on the Log Off popup). Off by default, also with `SAP_WRITE=on`: logging off drops the unsaved work of every session, and only you can log on again |

Lists are separated by commas (or spaces) and are not case-sensitive.

The transaction lists apply to commands (`/nSE38`, `/oSE38`, `/*SE38`) and
to the transaction the session is in. A menu entry, a favourite or a
double-click in a tree can open a transaction without a command: the
server reads the transaction before and after each action. If an action
lands in a transaction the lists refuse, the server says so and leaves it
with `/n`. If the session is already in one, only a command that leaves it
is accepted. `/nex`, `/nend` and `/i` close sessions; they are not
transactions, and `SAP_ALLOW_LOGOFF` decides on them. On Fiori the
"transaction" is the app's intent (such as `SalesOrder-display`), and the
lists compare against that; a Web GUI app inside the launchpad is not
checked by its transaction code.

Each surface classifies an action before it runs:

- **read:** value help, expanding a tree node, scrolling a list, listing a
  dropdown's entries;
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

Failing closed has a cost: with `SAP_WRITE=off`, some harmless buttons are
refused too (for example "Continue" on a popup whose text the server does
not know as safe). The agent is told why, and can tell you.

**A screen that only displays** (Web GUI): when the title of the main
window says "Display ..." and the system toolbar has no Save, the
transaction's own buttons and menu entries count as navigate (item
conditions, schedule lines, a list of orders). SAP offers no way to save
there. Still held: anything named with a commit word, functions that act
beyond the screen (print, issue output, start, execute...), the System and
Help menus, and the toolbar buttons of grids and trees.

**Execute (F8)** counts as navigate on purpose. It runs reports and lists
(VA05, ME2N...), which read. In Web GUI, Execute on a selection screen is a
commit when the screen shows that the report updates: a "Test Run" box that
is not ticked (tick it, and the report runs without writing), an "Update
Run" choice that is selected, or a title that names what the report does
and not a list ("Deletion of Jobs", "Batch Input: Process All Sessions").
A report that updates without any of these signs still runs: put known
update programs in `SAP_BLOCK_TCODES`.

A slow action can be given more time with `"timeout"` in seconds, up to
600, for example `{"do":"key","key":8,"timeout":300}` (SAP GUI and Web
GUI). Without it an action waits 180 seconds for SAP.

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
safe list can still write, and so can a report started with F8. Use a test
system and a user with the authorisations you want the agent to have.

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
  failure. `sap_replay` does the same from the agent. A step that may write
  needs `SAP_WRITE=on`: a replay cannot ask for each step.
- `export` writes a SAP Cloud ALM manual test case, a SAP GUI script (VBS), a
  Playwright spec for Web GUI or Fiori, or a Gherkin feature. The Playwright
  spec logs on by itself from `SAP_WEBGUI_URL` (or `SAP_FIORI_URL`),
  `SAP_USER` and `SAP_PASSWORD`, and reads variables from `SAP_VAR_<NAME>`.

Recordings go to `SAP_RECORD_DIR` (default `./sap-tests`) and hold the values
that were typed: treat them like the system's data. Design, file format and
limits: [docs/record.md](docs/record.md). Record and replay have been run on
Web GUI; not yet on SAP GUI for Windows or Fiori.

## Configuration

Every setting is an environment variable of the server process.

| Variable | Default | Effect |
| --- | --- | --- |
| `SAP_WRITE` | `off` | `off`, `confirm` or `on`: what happens to actions that may write ([Safety model](#safety-model)) |
| `SAP_ALLOW_SYSTEMS` | all | systems, optionally with a client, the server may see and use: `ABA/800,S4H` |
| `SAP_ALLOW_TCODES` | all | the only transactions the agent may open or work in |
| `SAP_BLOCK_TCODES` | none | transactions the agent may not open or work in |
| `SAP_ALLOW_ORIGINS` | all | browser origins the server looks at: `https://myhost:44300` |
| `SAP_SURFACES` | `sapgui,webgui,fiori` on Windows, `webgui,fiori` elsewhere | which kinds of session to look for |
| `SAP_GUI_METHOD` | scripting | `diag` reads SAP GUI from its traffic instead of scripting (experimental) |
| `SAP_DIAG_PORT` | `3298` | port of the local SAProuter for `SAP_GUI_METHOD=diag` |
| `SAP_DIAG_CAPTURE` | off | a folder where the `diag` method keeps the raw traffic, to debug the decoder. It holds everything SAP GUI sent and received, your logon included: keep it local and delete it after use |
| `SAP_CHROME_CDP` | the running Chrome, Chrome beta or Edge | a Chrome DevTools endpoint to attach to, e.g. `http://127.0.0.1:9333` |
| `SAP_VIEW` | `diff` | `full`: every action answers with the whole screen |
| `SAP_FIORI_WAIT` | full waits | `busy`: faster Fiori waits (busy indicators only, without UI5's RecordReplay) |
| `SAP_RECORD_DIR` | `./sap-tests` | where recordings and exports are written |
| `SAP_DOWNLOAD_DIR` | `downloads` in `SAP_RECORD_DIR` when that is set, else `./sap-downloads` | Web GUI: where a file SAP writes "to a local file" (List > Export > Local File) is copied. Web GUI keeps such a file inside the browser; the answer of the action names the copy |
| `SAP_RECORD` | `off` | `on`: record every session from its first action |

`sap-gui-mcp-server --help` lists the commands and the main settings.

## Limits

- **SAP GUI for Windows:**
  - SAP GUI for Java (macOS, Linux) has no scripting: on a Mac, use Web
    GUI or Fiori.
  - HTML panels inside SAP GUI (such as SE80's object selector) cannot be
    reached by scripting; use `sap_screenshot` to see them.
  - Scrolling long lists is covered by tests against a fake SAP GUI, but
    has not been run against a real SAP GUI yet.
  - The `diag` method is experimental: it needs the window on screen,
    cannot read SNC-encrypted connections, and acts with the keyboard and
    mouse.
- **Browsers:** Chrome is supported; Microsoft Edge (also Chromium) is
  found the same way and is likely to work; Firefox and Safari are not.
- **Long lists:**
  - The view shows the rows on screen with the total; `scroll` and
    `sap_look` with `rows` reach the others (see [Long lists](#long-lists)).
  - Lists scroll down and up, not sideways: a grid wider than the screen
    shows the columns SAP has drawn.
  - Web GUI draws only the tree nodes in view; a node further down is
    reached by scrolling the tree first.
- **Web GUI in a background tab:** Chrome draws a tab that is not in front
  about once a second, and hands it clicks and keys just as slowly. The
  server notices and waits longer (two to three seconds per action instead
  of one). It works, but a tab in front, or a window of its own, is faster.
- **When SAP does not answer:** an action waits up to 180 seconds (or its
  `timeout`), then says that SAP is still working. If the connection to SAP
  drops, the action says that the request failed; the page then needs a
  reload. A session that timed out shows as a `WINDOW browser` with a note.
- **Safe and commit words** are known in a handful of logon languages (see
  [Safety model](#safety-model)); in others more actions are held.
- **Record and replay** are a prototype ([docs/record.md](docs/record.md)).

## Skill

[`skills/sap-gui-drive`](skills/sap-gui-drive/SKILL.md) teaches an agent how
SAP screens behave (fields take effect on Enter, popups first, value help
instead of guessed codes, never work around the write setting). The Claude
Code plugin installs it; for other agents, copy the folder into their skills
directory (for Claude Code without the plugin: `~/.claude/skills/`). It also
ships in the npm package, under `skills/`.

## Benchmark

[`bench/`](bench/README.md) holds a benchmark harness: 72 whole tasks on SAP
GUI for Windows, Web GUI and Fiori, checked by reading the SAP database, to
compare this server with other ways of driving SAP. It needs your own SAP
demo systems. No full run has been made yet, so there are no results to
quote. It is not part of the npm package.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): the tests run without an SAP system.
Report security issues as described in [SECURITY.md](SECURITY.md).

## Licence and trademarks

MIT, see [LICENSE](LICENSE).

This project is not affiliated with, endorsed by or sponsored by SAP SE.
SAP, SAP GUI, SAP Fiori, SAPUI5, SAP S/4HANA, ABAP and other SAP products
and services mentioned here are trademarks or registered trademarks of SAP
SE (or an SAP affiliate company) in Germany and other countries. All other
names are the property of their owners.
