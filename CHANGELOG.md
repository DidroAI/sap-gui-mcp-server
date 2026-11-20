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
  with the keyboard and mouse (see below).
- Sessions are found by themselves; `sap_use` switches between them.

### Tools

- `sap_sessions`, `sap_use`, `sap_look`, `sap_act`, `sap_screenshot`,
  `sap_record`, `sap_replay`.
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

- Writes are off by default (`SAP_WRITE=off`); `confirm` asks the user
  for each one through MCP elicitation, and refuses it when the client
  cannot ask.
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

### SAP GUI without scripting (DIAG method, experimental)

- **Reading.** The decoder is our own (MIT), its item types, ids and sizes
  established from captured traffic. On the ECC screens captured while it
  was built, the view held nearly all the texts and values that SAP GUI
  scripting reads of the same screens, including ALV cells, tree nodes,
  table-control columns and popup entries. Controls of an ended
  transaction no longer show on the next one.
- **The view, as on the other surfaces.** The status bar is the `sbar` line,
  so errors and warnings come first in an answer; greyed-out buttons, keys,
  menus and tree nodes are marked, and `sap_look` with `id "mbar"` lists
  every menu entry; empty read-only fields show as `NAME@col=""`; a value
  typed with `set` shows as typed until SAP gets it with the next Enter,
  and a field that then shows something else is reported.
- **Ids.** A field name, `{FCODE}` of a push button or tab, a toolbar
  button or key by its text, `FIELD[n]` (the table's own row number, as the
  view prints it; a row not on show is scrolled to, and nothing is done if
  it does not come) or `@row,col`. Scripting cell ids `FIELD[col,row]`
  count the row from the first row on show. Toolbar buttons and function
  keys carry no function code in the traffic, so `{CODE}` does not name
  them: the refusal lists the screen's keys.
- **Actions.** `okcode`, `key`, `set`, `press`, `click`, `dblclick`,
  `select`, `check`, `focus` (fields), `f4` (fields), `combo`, vertical
  `scroll`, `tree`, `grid`, `toolbar`, and `sap_look` with `id`, `rows` and
  `cols`. Refused, with what to do instead: `focus`, `f4`, `set` or
  `check` where their first click would press, tick or open something;
  scrolling or reading other rows while typed values have not reached SAP;
  sideways scrolling; a grid toolbar button named by part of its name;
  input to a window that cannot be told apart without doubt from another
  SAP GUI window. The guard judges the input sent: a click on a push button
  or a box with a function code is rated as pressing it, a click on an
  element the reader cannot classify as a write.
- **Waits.** An action ends when SAP has answered the request of its last
  input, read from the traffic, not after a timer; `timing` says where the
  time went. A lost or unreadable answer ends the wait with "session state
  unknown", and the next `sap_look` recovers.
- **Record and replay.** Tests name controls the way the actions do and
  record the method (a `diag` test is not replayed through scripting, nor
  exported to VBS). Information popups are passed with their Enter key; a
  recorded Enter on a popup that only informed is not sent when SAP does
  not show it; the answer to a question is never skipped (the step fails);
  a screen damaged in transit is never judged.
- **Robustness.** Lost or garbled bytes no longer blind the connection: the
  decoder finds its place again (in linear time), and the view says when a
  screen may miss parts or holds something it cannot read yet. Compressed
  blocks over 64 MB are refused. The relay outlives a failing reader or
  capture, closed connections are let go, router messages go to stderr,
  and `doctor` reports what was lost or not read, and SNC (not readable).
- **Not verified live yet:** the actions, waits, cell sizes, window
  matching and record/replay ran against synthetic traffic and captures
  only, not against SAP GUI.

### Command line

- `setup` adds the server to Claude Code, Codex and Claude Desktop;
  `doctor` checks what the server can reach and says what to change;
  `sessions` lists the SAP sessions found.

### Also in the repository

- `skills/sap-gui-drive`, a skill for agents working in SAP screens, also
  shipped in the npm package and as a Claude Code plugin.
- `bench/`, a benchmark harness with 72 tasks (not in the npm package; no
  results yet).
