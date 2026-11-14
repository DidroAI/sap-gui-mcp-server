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
btn[3]  button  Back (F3)
btn[8]  button  Create with Reference (F8)
ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
boxTEXT  group  Organizational Data
ctxtVBAK-VKORG  field  Sales Organization = ""  (edit)
ctxtVBAK-VTWEG  field  Distribution Channel = ""  (edit)
ctxtVBAK-SPART  field  Division = ""  (edit)
mbar  menubar  Sales document {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, ...
```

(Web GUI, transaction VA01; SAP's messages appear as a `sbar  status` line.)

The agent acts on those ids with one small set of JSON actions, the same on
every surface. After an action on the same screen it gets only what
changed:

```
set wnd[0]/usr/ctxtVBAK-VKORG

CHANGED 1 of 18 lines (same screen; sap_look shows all of it):
~ ctxtVBAK-VKORG  field  Sales Organization = "1000"  (edit)
```

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

Over a run, an agent pays for every answer. On Web GUI of an ECC demo
system, a read-only flow of 51 steps (VA01 without saving, VA03, VA05,
SE16N, SE16, MM03; `test/dev/soak.ts`, one run, tokens counted with the
Anthropic `count_tokens` API) cost 58k tokens of answers. With
`SAP_VIEW=full`, where every action answers with the whole screen, the
same flow cost 73k. Typing into a field answers with about 50 tokens
instead of the screen (540 on the VA01 initial screen, 2,900 on its
overview).

## Set up with your agent

The easiest way: paste the prompt in [docs/setup-prompt.md](docs/setup-prompt.md)
into Claude Code or Codex. The agent installs the server, adds it to your MCP
clients (`setup`), runs `doctor` and walks you through each setting, then
looks at your SAP screen to prove it works.

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

Or let the server add itself to every MCP client it finds (Claude Code,
Codex, Claude Desktop); it never overwrites an existing entry and keeps a
`.bak` of any file it changes:

```sh
npx -y sap-gui-mcp-server setup --dry-run   # what it would change
npx -y sap-gui-mcp-server setup
```

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

**SAP GUI without scripting (experimental): `SAP_GUI_METHOD=diag`.** When
scripting is off, the server can read SAP GUI from the traffic between SAP GUI
and the SAP system (SAP's DIAG protocol) instead:

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
| `sap_look` | the screen as compact text; `full: true` for every id and column; `diff: true` for what changed since the last view; `id` for one control whole; `id` and `rows` for a range of rows of a long list |
| `sap_act` | one action, then the new screen, or only what changed when the screen is the same one |
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
{"do": "combo", "id": "cmbTYPE"}
{"do": "okcode", "value": "/nVA03"}
{"do": "f4", "id": "ctxtVBAK-VKORG"}
{"do": "dblclick", "id": "lbl[1,13]"}
{"do": "tree", "id": "shell", "node": "  4", "how": "double"}
{"do": "grid", "id": "cntlGRID1/shell", "row": 120, "col": "VBELN", "how": "double"}
{"do": "scroll", "id": "cntlGRID1/shell", "to": 120}
```

For `key`, 0 is Enter, 3 Back, 4 F4, 8 F8, 11 Save and 12 Cancel; a key
is a number from 0 to 99 or a key name (`Enter`, `Escape`, `Shift+Tab`,
`Control+S`). `combo` without a key lists the dropdown's entries and
chooses nothing. `scroll` takes a row counted from 0, or `"next"`,
`"prev"`, `"first"`, `"last"`. Fiori also takes `click`.

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

On SAP GUI for Windows, the host and the fake SAP GUI of the tests got the
scroll code in this version; it has not been run against a real SAP GUI yet.

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

**Execute (F8)** counts as navigate on purpose. It runs reports and lists
(VA05, ME2N...), which read. A report that updates the database usually
has a test-run flag and asks before posting, but not always. Put known
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
safe list can still write, and so can a report started with F8. Use a test system and
a user with the authorisations you want the agent to have.

Other settings:

| Setting | Effect |
| --- | --- |
| `SAP_SURFACES=sapgui,webgui,fiori` | which kinds of session to look for |
| `SAP_VIEW=full` | every action answers with the whole screen (default `diff`: only what changed when the screen is the same) |
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
- **Long lists:**
  - The view shows the rows on screen with the total; `scroll` and
    `sap_look` with `rows` reach the others (see "Long lists").
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

## Development

```sh
bun install
bun run typecheck && bun test && bun run build
node dist/cli.js doctor
```

`test/dev/webgui-logon.ts` and `test/dev/fiori-logon.ts` log a
throwaway Chrome on to a test system for live checks. They read the
password from a file and never print it.

`test/dev/soak.ts` walks a logged-on Web GUI session through about sixty
read-only steps (VA01 without saving, VA03, VA05, SE16N, SE16, MM03) and
reports failures, time and tokens per step. `test/dev/measure.ts` counts
what each rule of the compact view saves on a set of screens. Both count
tokens with the Anthropic `count_tokens` API when `ANTHROPIC_API_KEY` is
set, and write screen content only where you tell them to: keep that out
of Git.

The browser tests run on synthetic pages and need a Chrome:
`SAP_TEST_CHROME=/path/to/chrome bun test`.

## Licence

MIT. SAP, SAP GUI, SAP Fiori and SAPUI5 are trademarks of SAP SE. This
project is not affiliated with SAP.
