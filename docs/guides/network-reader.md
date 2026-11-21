# Network reader (no scripting)

::: warning Experimental
This method has run against synthetic traffic and recorded captures only,
not yet against SAP GUI itself. See [Limits](#limits).
:::

When SAP GUI scripting is off, on your PC or on the SAP system, the server
can read SAP GUI for Windows from the traffic between SAP GUI and the SAP
system (SAP's DIAG protocol) instead. It acts with the keyboard and, where
SAP GUI has no key, the mouse.

## How it works

The server runs a SAProuter on your PC. You point SAP GUI's connection
entry at it; the server passes SAP GUI's traffic on to the SAP system and
decodes a copy: the screen as SAP sent it, with SAP's field names, every
row of tables, grids and lists, and tree nodes.

- The bytes go on as they came, except the route request when another
  SAProuter follows, which is passed on one hop further.
- Nothing is loaded into SAP GUI.
- It cannot read connections encrypted with SNC.
- The server must be running before you log on, since SAP GUI connects
  through it.

## Setup

1. Set `SAP_GUI_METHOD=diag` in the server's environment. The server then
   runs a SAProuter on `127.0.0.1:3298` (`SAP_DIAG_PORT` to change it).
2. In SAP Logon, edit the connection entry: put `/H/127.0.0.1/S/3298` at the
   start of its SAProuter string (before your company's router, if there is
   one), and log on again.

For example, a connection entry with no router of its own gets the
SAProuter string `/H/127.0.0.1/S/3298`; one that had `/H/router.example.com/S/3299`
gets `/H/127.0.0.1/S/3298/H/router.example.com/S/3299`.

In Claude Code:

```sh
claude mcp add sap-gui --scope user -e SAP_GUI_METHOD=diag -- npx -y sap-gui-mcp-server
```

Then check with `doctor`:

```sh
SAP_GUI_METHOD=diag npx -y sap-gui-mcp-server doctor
```

It checks that the router listens, how many SAP GUI connections go through
it, whether the reader could read what SAP sent, and what the router
reported as going wrong (a refused route, a reader or capture that failed).
A refused route is a connection entry whose SAProuter string does not lead
on from this router.

`doctor` runs in a process of its own, with a router of its own. While your
MCP client's server runs and holds the port, `doctor` reports the port as
taken and cannot see that server's connections: what that server's router
reports goes to its log (stderr).

### Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `SAP_GUI_METHOD` | scripting | `diag` reads SAP GUI from its traffic instead of scripting |
| `SAP_DIAG_PORT` | `3298` | port of the local SAProuter |
| `SAP_DIAG_CELL` | from the traffic | `cw,ch[,x0,y0]`: the pixel size of SAP GUI's character cell (and the offset of the first one in the screen area), if clicks miss on a theme or scaling |
| `SAP_DIAG_REQUEST_MS` | `3000` | how long to wait for SAP GUI to send a request after a key or a click, before saying the input may have missed |
| `SAP_DIAG_QUIET_MS` | `60` | how long the traffic must be quiet after SAP's answer before an action ends |
| `SAP_DIAG_CAPTURE` | off | a folder where the raw traffic is kept, to debug the decoder (see [Capture](#capture)) |

## What the view gives

The same kind of view as the other surfaces ([The screen
view](../concepts/screen-view.md)):

- the status bar as an `sbar` line (an error or warning comes first in an
  answer);
- what SAP greys out, marked `(greyed out)`;
- every menu entry, with `sap_look` and `id "mbar"`;
- empty read-only fields as `NAME@col=""`.

A value typed with `set` reaches SAP (and so the reader) only with the next
Enter or function key: until then the view shows it marked `(typed, sent
with the next Enter)`, and if the field then shows something else, the
answer says so.

When bytes were lost on the connection, or SAP sent something the reader
cannot read yet, a `note` line at the end of the view says so; `doctor`
counts both.

## Ids

- A SAP field name: `VBAK-VBELN`.
- A push button or a tab by its function code in braces: `{HEAD}`.
- A toolbar button or function key by its text: `Back`.
- A table cell `FIELD[n]`, with the table's own row number as the view
  prints it. A row not on show is scrolled to first; if it does not come on
  show, nothing is done.
- A position: `@row,col`.
- Grids and trees go by their container name.

An id written nearly right (another case, a scripting id such as
`wnd[0]/usr/ctxtVBAK-VBELN`, a column index) is taken when it means one
thing; in a scripting cell id `FIELD[col,row]` the row counts from the
first row on show, as scripting counts it. A name several controls share is
refused with their places, and an unknown id with the closest ones.

Toolbar buttons and function keys have no function code in the traffic, so
`{BACK}` does not name one: the refusal lists the keys of the screen. A
function code can still go through the command field with `okcode`.

## Actions that work

- `okcode`, `key`, `set` (a field, a table cell);
- `press`, `click`, `dblclick` and `select` (buttons, tabs, fields, list
  positions, table rows, grid rows, tree nodes);
- `check` (checkboxes and radio buttons);
- `focus` (a field, a grid row, a tree node);
- `f4` (a field);
- `combo`, by the text the dropdown shows: its entries are not in the
  traffic;
- `scroll` up and down (table controls, lists, grids);
- `tree`, `grid`;
- `toolbar`: the screen's toolbar by text or a known ALV function code
  such as `&SORT_ASC`; a grid's own toolbar by a button's whole name;
- `sap_look` with `id`, `rows` and `cols`.

Keyboard first: function keys and the command field for buttons, Ctrl+Home
and the arrow keys to a grid cell or a tree node, Page Down and Page Up for
table controls and lists. The mouse goes only where SAP GUI has no key
(into a field, a dropdown, a row selector, a grid's column header to give
it the focus), at a point computed from the cell size SAP GUI reports in
the traffic, so SAP GUI's window must be on the screen.

## Actions that are refused, and why

Each refusal says what to do instead.

- `focus`, `f4`, `set` and `check` where their first click would press,
  tick or open something: on a push button, a toolbar button, a tab, a
  dropdown, a list line, or an element the reader cannot classify (`check`
  only on checkboxes and radio buttons, `set` only on fields).
- `scroll`, and `sap_look` with `rows` that would scroll, while values
  typed with `set` or boxes ticked with `check` have not reached SAP: a
  page key would send them. The view marks them `(typed, …)` and
  `(ticked, …)`.
- A table control is not paged when its first row on show has no plain
  field to put the cursor in.
- Sideways scrolling (the view already has every column SAP sent).
- A grid toolbar button named by part of its name, and a button found for a
  word rated safe whose own name says it writes.
- Anything SAP greys out, and any action on the logon screen.
- Any input when the session's window cannot be told apart without doubt
  from another SAP GUI window with the same title (one that may not go
  through the router), or when that window is minimised.

The guard rates an action by the input it sends: any click on a push
button or a box with a function code is judged as pressing it, and a click
on a button in a table-control row or on an element the reader cannot
classify is treated as a write ([Safety model](../concepts/safety.md)).

## Waits

An action ends when SAP has answered the request its last input made (and
every request before it), as seen in the traffic, not after a fixed time.
If SAP GUI sent nothing after a key or a click, or SAP has not answered
within the action's `timeout` (60 seconds by default, up to 600), the
answer says so; `sap_look` during a step still running says the screen
will change.

If SAP's answer was lost or could not be read on the connection, the action
says the session state is unknown; the next action is refused until any
`sap_look` (with or without an id), which takes the last screen read whole
as the state. Bytes lost on the connection that cannot be told to one
session never cut another session's step short.

## Windows

Several sessions (`/o`) are matched to their windows by title, by the
system and client in the status bar's system field (never read from the
status message), by the status bar's message, and by the window each was
first matched to without doubt. Showing the system and client in SAP GUI's
status bar helps when several windows share a title.

## Record and replay

`sap_record` and `sap_replay` work with this method: a test names controls
the way the actions do and records the method, so it is replayed with the
same method (and not exported to VBS).

- Information popups are passed with their Enter key. A recorded Enter on a
  popup that only informed is not sent when SAP does not show that popup
  this time (its checks still run).
- The recorded answer to a question (Yes, Save, any button of a popup that
  asks) is never skipped: if SAP does not show the question, or shows
  another popup in its place, the step fails.
- A screen damaged in transit is never judged: the replay waits for a
  whole one, or fails the step with "screen damaged in transit".

See [Recording and replay](record-replay.md).

## Robustness

Lost or garbled bytes do not blind the connection: the decoder finds its
place again and marks the screens that may miss parts. A compressed block
that says it holds more than 64 MB is not read. The router keeps SAP GUI's
connection even if the reader fails, and writes what went wrong (a refused
route, a reader or capture that failed) to the server's log (stderr) and
to `doctor`.

## Capture

`SAP_DIAG_CAPTURE=<folder>` keeps a copy of the raw traffic to debug the
decoder (off by default).

::: warning
The file holds everything SAP GUI sent and received, your logon included.
Keep it local and delete it after use.
:::

The file is made readable by its owner only where the system allows it. A
capture that cannot be written is stopped and reported; reading and the
logon go on.

## Limits

- **Live status.** First run against SAP GUI for Windows on 20 November
  2026: reading, batches, long lists, the guard and record and replay
  work. Writes over this method have not been tried on a live system yet.
  Expect to set `SAP_DIAG_CELL` on another theme or scaling.
- **The router lives and dies with the server.** SAP GUI connects through
  the server's router, so when the server stops, SAP GUI's connection
  drops and you must log on again. Most MCP clients start the server per
  conversation and stop it when the conversation ends, which logs SAP GUI
  off each time. Keep one long-lived server process for this method: for
  example the [agent CLI](cli-for-agents.md), whose daemon stays up between
  calls (raise `SAP_CLI_IDLE`, in minutes, default 30).
- **The view is bounded by SAP GUI's window.** SAP sends a screen sized to
  the window, so a small window gives a short, narrow view, and lists are
  cut at its width. Maximise SAP GUI.
- **Inputs can miss.** An Enter or a double-click that SAP GUI did not turn
  into a request within `SAP_DIAG_REQUEST_MS` is answered "SAP GUI sent
  nothing to SAP ... the input may have missed": look, then send it again.
- It needs SAP GUI's window on the screen (not minimised), since it acts
  with the keyboard and mouse.
- It cannot read connections encrypted with SNC.
- It runs on Windows, like SAP GUI for Windows.
- Lists do not scroll sideways; the view already has every column SAP sent.
