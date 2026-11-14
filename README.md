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

On our test screens (SAP demo systems, ten screens per surface, one action
per test), the compact view saw:

| Surface | Screen content seen | Tokens, ten screens | Actions that worked |
| --- | --- | --- | --- |
| Web GUI | 100% (Playwright MCP: 100%) | 20k (Playwright MCP: 203k) | 6 of 6 |
| SAP GUI for Windows | 99% (best other SAP GUI MCP: 53%) | 24k | 5 of 5 that scripting can reach |
| Fiori (S/4HANA launchpad) | 99% | 35k (Playwright MCP: 101k) | 6 of 7 |

The other servers' labels and checkbox states were the weak point:
Playwright MCP paired 66% of labels with their values on Web GUI and showed
no checkbox state. A public, repeatable benchmark is on the way.

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
`npx -y sap-gui-mcp-server`.

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

1. `SAP_CHROME_CDP`, if you set it, e.g. `http://127.0.0.1:9222`;
2. your running Chrome, once you allow it: open
   `chrome://inspect/#remote-debugging` and tick *Allow remote debugging*.
   This needs Chrome 144 or later; Chrome asks you to confirm when the
   server connects;
3. a Chrome started with `--remote-debugging-port=9222`.

The server tells Web GUI tabs (`/sap/bc/gui/sap/its/webgui`) from Fiori
tabs (UI5 in the page). It reads system, client and user from the page.
Closing the server never closes your browser.

## Tools

| Tool | Does |
| --- | --- |
| `sap_sessions` | lists the SAP sessions open on this machine; `*` marks the active one |
| `sap_use` | makes another session the active one |
| `sap_look` | the screen as compact text; `full: true` for every id and column |
| `sap_act` | one action, then the new screen |
| `sap_confirm` | runs an action held for your confirmation (see below) |
| `sap_screenshot` | a PNG of the window or tab, for charts and visual checks |

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

For `key`, 0 is Enter, 3 Back, 4 F4, 8 F8, 11 Save and 12 Cancel. Fiori
also takes `click` and `scroll`.

## Guardrails

The server enforces these whatever the agent decides:

| Setting | Effect |
| --- | --- |
| `SAP_WRITE=off` (default) | actions that may write to SAP are refused: Save, Post, Delete, Release, Approve, "Yes" on a save popup |
| `SAP_WRITE=confirm` | such actions are held; the agent must ask you, then call `sap_confirm` with the token |
| `SAP_WRITE=on` | such actions run |
| `SAP_ALLOW_SYSTEMS=ABA/800,S4H` | only these systems, optionally with a client, are visible and usable |
| `SAP_ALLOW_TCODES=VA03,MM03` | the agent may open only these transactions |
| `SAP_BLOCK_TCODES=SE38,SM30` | the agent may not open these transactions |

Each surface classifies an action before it runs:

- **read:** value help, expanding a tree node;
- **navigate:** typing, Enter, tabs, Back;
- **commit:** anything that may save.

Commits are recognised by the key (Save), the function code (`/11`,
`SAVE`), and the text, tooltip or id of the button or menu entry, in
English, German and French. When the server is unsure, it treats the action
as a commit.

This is a safety net, not a guarantee. A custom button with a neutral name
can still write, and so can a report started with F8. Use a test system and
a user with the authorisations you want the agent to have.

Other settings:

| Setting | Effect |
| --- | --- |
| `SAP_SURFACES=sapgui,webgui,fiori` | which kinds of session to look for |
| `SAP_FIORI_WAIT=busy` | faster Fiori waits (busy indicators only) |

## Limits

- **SAP GUI:**
  - SAP GUI for Java (macOS, Linux) has no scripting: on a Mac, use Web
    GUI or Fiori.
  - HTML panels inside SAP GUI (such as SE80's object selector) cannot be
    reached by scripting; use `sap_screenshot` to see them.
- **Browsers:** Chrome is supported; Edge (also Chromium) is likely to
  work; Firefox and Safari are not.
- **Long lists:** these show the rows on screen, with the total count.

## Development

```sh
bun install
bun run typecheck && bun test && bun run build
node dist/cli.js doctor
```

`scripts/dev-webgui-logon.ts` and `scripts/dev-fiori-logon.ts` log a
throwaway Chrome on to a test system for live checks. They read the
password from a file and never print it.

## Licence

MIT. SAP, SAP GUI, SAP Fiori and SAPUI5 are trademarks of SAP SE. This
project is not affiliated with SAP.
