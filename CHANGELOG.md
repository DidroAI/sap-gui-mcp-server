# Changelog

All notable changes to this project are listed here. The project follows
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
change the tools or the view format.

## 0.1.0 (unreleased)

The first public version.

### Surfaces

- **SAP GUI for Windows**, through SAP GUI scripting, driven from Windows
  PowerShell (nothing else to install).
- **SAP GUI for HTML (Web GUI)** and **SAP Fiori** in Chrome (or Edge),
  attached to the browser you already use once remote debugging is
  allowed, or to a DevTools endpoint named in `SAP_CHROME_CDP`.
- **SAP GUI without scripting (experimental)**: `SAP_GUI_METHOD=diag` reads
  the screen from SAP GUI's DIAG traffic through a local SAProuter, and acts
  with the keyboard and mouse. It has every action of the other surfaces
  (dropdowns, scrolling, grid and tree actions, grid toolbars, `sap_look`
  with `id`, `rows` and `cols`), waits for SAP's answer in the traffic
  instead of a timer, takes the cell size SAP GUI reports, and tells
  same-titled sessions apart.
- Sessions are found by themselves; `sap_use` switches between them.

### Tools

- `sap_sessions`, `sap_use`, `sap_look`, `sap_act`, `sap_confirm`,
  `sap_screenshot`, `sap_record`, `sap_replay`.
- One set of JSON actions on every surface: `set`, `press`, `key`,
  `select`, `check`, `combo`, `okcode`, `f4`, `focus`, `dblclick`, `tree`,
  `grid`, `toolbar`, `scroll` (and `click` on Fiori).

### The view

- A compact text view with one line per control, SAP's ids shortened to
  unique handles, labels paired with values, checkbox states, tree nodes,
  ALV grid cells, table controls, classic lists and popups.
- After an action that leaves the session on the same screen, only what
  changed (`SAP_VIEW=full` for the whole screen each time).
- Long lists: `scroll`, and `sap_look` with `id` and `rows` to read a range.
- An id that names several controls, or none, is refused with what the
  screen holds; the server never picks the nearest match.

### Safety

- Writes are off by default (`SAP_WRITE=off`); `confirm` holds them for
  the user's yes, through MCP elicitation when the client supports it.
- Every action is classified as read, navigate or commit, failing closed.
- Allow and block lists for systems, transactions and browser origins.
- Never logs on, never types into password fields, never acts on a logon
  screen.

### Record and replay (prototype)

- `sap_replay` can resume at a failed step with a repair for that one step
  (`from`, `repair`, `"format":"json"`): a few actions or a capture, carried
  out under fixed rules (no added write, no leaving, no invented data, the
  recorded checks still judge), with a proposed change to the test in the
  result. The server calls no model.
- `sap_record` keeps a run as a test file; `sap_replay` and
  `sap-gui-mcp-server replay` run it again with no model.
- `export` writes a SAP Cloud ALM manual test case, a SAP GUI script (VBS),
  a Playwright spec, or a Gherkin feature.

### Command line

- `setup` adds the server to Claude Code, Codex and Claude Desktop;
  `doctor` checks what the server can reach and says what to change;
  `sessions` lists the SAP sessions found.

### Also in the repository

- `skills/sap-gui-drive`, a skill for agents working in SAP screens, also
  shipped in the npm package and as a Claude Code plugin.
- `bench/`, a benchmark harness with 72 tasks (not in the npm package; no
  results yet).
