# Actions reference

This page lists every action `sap_act` takes (16 verbs), its fields, and
which surface supports it.
For how an action is judged and run, see [Actions](../concepts/actions.md)
and [Safety model](../concepts/safety.md).

Source: [`src/core/action.ts`](https://github.com/DidroAI/sap-ui-automation/blob/main/src/core/action.ts)
(the shape every action is brought to) and the surface drivers under
[`src/`](https://github.com/DidroAI/sap-ui-automation/tree/main/src).

## The shape of an action

An action is a flat JSON object. `sap_act` takes its fields at the top
level of the call, beside `session` and `full`:

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
```

| Field | Type | Used by |
| --- | --- | --- |
| `do` | one of the 16 verbs below, required | every action |
| `id` | string | the control, as the view shows it (a handle, a full id, or a field's SAP name). Required for `set`, `press`, `click`, `select`, `check`, `combo`, `f4`, `focus`, `dblclick`, `tree`, `grid`, `toolbar` |
| `value` | string, number or boolean | `set`, `check`, `okcode`, `select` with `row` |
| `key` | number or string | `key`, `combo` |
| `node` | string | `tree` (a number is turned into text) |
| `how` | string | `tree`, `grid` |
| `row` | whole number, 0 or more | `grid`, `select`, `check`, `set` on a grid, `dblclick` |
| `col` | string | `grid`, `tree`, `set` on a grid (a number is turned into text) |
| `button` | string | `toolbar` |
| `app` | string | `open` |
| `to` | whole number or string | `scroll` |
| `timeout` | number, in seconds | any action on SAP GUI for Windows and Web GUI: how long to wait for SAP (default 180), up to 600 |
| `timing` | boolean | any action: add a line that says where the time went (also `SAP_TIMINGS=on`). Not part of the action, and not in the schema |

Before anything reads it, the server brings the action to one shape
([`normalizeAction`](https://github.com/DidroAI/sap-ui-automation/blob/main/src/core/action.ts)):

- `do` is one of the 16 verbs below, trimmed and lower-cased. Any other
  word is refused with the list of verbs.
- Field values must be a string, a number or a boolean. Objects and arrays
  are refused.
- Line breaks are removed from every string, except the `value` of a
  `set`: a text editor has lines. A one-line field gets a space for each
  line break, never the Enter key.
- `row` must be a whole number, 0 or more.
- A `key` action keeps `key` only: `value` is read as the key and dropped.

## Several actions in one call

`actions` in place of one action's fields runs up to 20 actions in order,
and answers once: what ran, why the batch ended if it ended early, and the
screen after the last action that ran.

```json
{"actions": [
  {"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"},
  {"do": "set", "id": "ctxtVBAK-VKORG", "value": "1000"},
  {"do": "key", "key": 0, "expect": {"screen": "4001"}}]}
```

Each entry is an action as above, with three more fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `expect` | object | what the step knows will happen, so the batch goes on through it. Any of `screen` (the screen number; leading zeros do not count), `transaction`, `title` (text the window title contains), `status` (a message type `S`, `I`, `W`, `E`, `A`, or text the message contains), `popup` (`true`: this step opens one; `false`: none is open after it). When the screen is not what `expect` says, the batch ends there |
| `show` | boolean | the answer also holds the screen after this step (to read one tab after another) |
| `unseen` | boolean | this step may write on a screen the batch reached after you sent it |

An `okcode` that opens a transaction (`/nVA03`) needs no `expect`: the
batch goes on into that transaction's first screen, so one call can open
the transaction and fill its first screen.

The batch ends before the next action when an action fails, is refused or
needs the user's yes (`SAP_WRITE=confirm`: it is asked about on its own); when a popup opens, the status bar shows E, W or
A, or the screen changes, unless `expect` names it; when `expect` is not
met; and when SAP is still working. An unknown key in `expect`, an entry
that is not a valid action, or a `/o...` command refuses the whole batch
before anything runs.

A write never runs on a screen you have not seen in the batch: an action
that may write, after the first, does not run when the screen or the
popups differ from the ones you saw when you sent the batch. Read the
screen in the answer and send the write again, or mark the step
`"unseen": true` when you know that screen. A write as the first action
needs SAP to be on the screen you were last shown, as a single write does.

How the answer reads: [MCP tools](tools.md#several-actions-in-one-call).

## Verbs

### set

Types a value into a field.

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
{"do": "set", "id": "cntlGRID1/shell", "row": 0, "col": "SEATSOCC", "value": "12"}
```

- On a checkbox or a radio button it acts as `check`; on a dropdown, as
  `combo` with `key` = `value`.
- In a text editor, `"\n"` in the value is a line break.
- Password fields are never typed into. The command field (`okcd`) is
  refused: use `okcode`.
- With `row` and `col` on a grid that takes input (an editable ALV), or on
  a table control: that cell.
- On SAP GUI for Windows with the network reader, a typed value reaches SAP
  only with the next Enter or function key. Until then the view marks it
  `(typed, sent with the next Enter)`.

### press, click

Presses a button.

```json
{"do": "press", "id": "btn[8]"}
```

- `btn[N]` in a toolbar is function key N: `press` on it and `key` N do the
  same.
- `click` is the same as `press` on SAP GUI for Windows (scripting) and on
  Fiori. The network reader takes it as a click at the control. Web GUI
  does not take `click`: use `press`.
- On Web GUI, `press` on `wnd[N]/close` closes a popup that has no button
  (the x in its title); `press` on the status bar opens the message's long
  text.

### key

Sends a key.

```json
{"do": "key", "key": 0}
{"do": "key", "key": "Shift+Tab"}
{"do": "key", "key": 8, "timeout": 300}
```

`key` is an SAP virtual key number from 0 to 99, or a key name:

| Number | Key |
| --- | --- |
| 0 | Enter |
| 3 | Back (F3) |
| 4 | F4 |
| 8 | F8 (Execute) |
| 11 | Save (Ctrl+S) |
| 12 | Cancel (F12) |

Key names: `Enter` (`Return`), `Escape` (`Esc`), `Tab`, `Backspace`,
`Delete` (`Del`), `Insert`, `Space`, `Home`, `End`, `PageUp`, `PageDown`,
`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` (`Up`, `Down`, `Left`,
`Right`), `Back`, `F1` to `F24`. Modifiers: `Control` (`Ctrl`), `Alt`,
`Shift`, `Meta` (`Cmd`, `Command`), joined with `+`. A letter or a digit is
a key only with Control, Alt or Meta (`Control+S`); alone it would type
text. Names are not case-sensitive.

- Enter on a question popup (Yes, No, Cancel in its body) is refused with
  the popup's answers: press the one you mean by its id.
- Escape with a menu or a list open closes that only.
- Each surface accepts the keys it has. SAP GUI for Windows (scripting)
  sends virtual keys only: 1 to 12 are F1 to F12, 13 to 24 Shift+F1 to
  Shift+F12, 25 to 36 Ctrl+F1 to Ctrl+F12, 37 to 48 Ctrl+Shift+F1 to
  Ctrl+Shift+F12; the names it maps are Enter, Escape (12), Back (3),
  Control+S, Control+E, Control+F, Control+G, Control+P, PageUp, PageDown,
  Control+PageUp, Control+PageDown and F1 to F12 with Shift and Control.
  Fiori takes Enter, Space, Escape,
  Tab, Shift+Tab, F4, Delete, Backspace, the arrow keys, PageDown, PageUp,
  Home, End, Back, Control+S, Control+Enter, and SAP GUI's 0, 3, 4, 11 and
  12. On Fiori, `Back` presses the launchpad's back button and never leaves
  the launchpad.

### select

Selects a tab, a radio button, a menu entry, a list item, or an open menu's
entry. With `row`, selects that row of a table control or a grid by its row
selector; `"value": false` deselects it.

```json
{"do": "select", "id": "tabpT\\08"}
{"do": "select", "id": "tblSAPMV45ATCTRL_U_ERF_AUFTRAG", "row": 2}
```

### check

Ticks or clears a checkbox, or chooses a radio button. `value` defaults to
`true`. Answers the state the box has after.

```json
{"do": "check", "id": "chkFLAG", "value": true}
```

- Also a list's `chk[col,row]` boxes.
- A radio button is cleared by choosing another one of its group.
- Web GUI: with `row` on a table control or a grid, ticks that row's
  selector, as `select` with `row` does.

### combo

Chooses a dropdown entry, by its key or the text it shows. Without `key`,
lists the entries and changes nothing.

```json
{"do": "combo", "id": "cmbTYPE", "key": "PROG"}
{"do": "combo", "id": "cmbTYPE"}
```

### okcode

Runs a command in the command field. The only way to use the command field.

```json
{"do": "okcode", "value": "/nVA03"}
```

- `/n<tcode>` leaves the transaction (unsaved input is lost) and starts
  another; `/o<tcode>` opens a new session (SAP GUI for Windows: a new
  window; Web GUI: a new browser window); the server follows it there, and
  it becomes the active one.
- `SAP_ALLOW_TCODES` and `SAP_BLOCK_TCODES` are checked against the command.
- `/nex`, `/nend` and `/i` end sessions or the logon: refused unless
  `SAP_ALLOW_LOGOFF=on`.

### f4

Opens value help on a field.

```json
{"do": "f4", "id": "ctxtVBAK-VKORG"}
```

### focus

Puts the cursor on a field (on the network reader also on a grid row or a
tree node).

```json
{"do": "focus", "id": "ctxtVBAK-VKORG"}
```

### dblclick

Double-clicks a list entry or a label. With `node` it acts as `tree` with
`how: "double"`; with `row`, as `grid` with `how: "double"`.

```json
{"do": "dblclick", "id": "lbl[1,13]"}
```

On SAP GUI for Windows (scripting) it puts the cursor on the control and
sends F2, as a double-click does.

### tree

Acts on a tree node, by the key the view shows as `{node <key>}`.

```json
{"do": "tree", "id": "shell", "node": "  4", "how": "double"}
{"do": "tree", "id": "shell", "node": "05 3 1", "col": "1"}
```

| `how` | Does |
| --- | --- |
| `double` (default) | double-clicks the node (with `col`: that item of the node) |
| `select` | selects the node |
| `expand`, `collapse` | opens or closes the node; a read for the guard |

Node keys are matched with or without their padding spaces. On Web GUI an
item of a node (`col`) is clicked once by default.

### grid

Acts on a cell, a row or a column of an ALV grid.

```json
{"do": "grid", "id": "cntlGRID1/shell", "row": 120, "col": "VBELN", "how": "double"}
{"do": "grid", "id": "cntlGRID1/shell", "col": "VBELN", "how": "select"}
```

| `how` | Does |
| --- | --- |
| `double` (default) | double-clicks the cell |
| `select` | selects the row; with `col` and no `row`, selects the column (for the grid's sort or total buttons) |
| `cell` | only puts the cursor on the cell |

A row that is not on screen is scrolled to first. A row the grid does not
have is an error that says how many rows it has. Support differs: see the
table below.

### toolbar

Presses a button of a control's own toolbar (an ALV grid's, for example).

```json
{"do": "toolbar", "id": "cntlGRID1/shell", "button": "&MB_FILTER"}
```

`button` is the id the view shows as `{<id>}`. On the network reader it is
the button's text or a known ALV function code (`&SORT_ASC`); a grid's own
toolbar button by its whole name.

### scroll

Moves a grid, table control, tree or list.

```json
{"do": "scroll", "id": "cntlGRID1/shell", "to": 120}
{"do": "scroll", "id": "cntlGRID1/shell", "to": "next"}
```

| `to` | Moves to |
| --- | --- |
| a whole number | that row, counted from 0 |
| `next`, `prev` | one page down or up (also `down`, `up`, `previous`) |
| `first`, `last` | the top or the end (also `top`, `bottom`, `start`, `end`) |
| `right`, `left`, `rightmost`, `leftmost` | a table control's columns, sideways. Web GUI only |

- Without `to`: `next`.
- Without `id`: the one control of the screen that scrolls; if there are
  several, the answer lists them.
- The answer says which rows are shown (`rows 60 to 84 of 93`).
- A scroll is a read for the guard.
- On Fiori, `scroll` moves a table or the page when the view ends with
  `SCROLL`.

### open

Fiori only. Opens a launchpad app by its intent: the part of the app's
address after `#`, with parameters if needed.

```json
{"do": "open", "app": "#SalesOrder-manage"}
{"do": "open", "app": "#SalesOrder-display?SalesOrder=4711"}
```

- Never a URL: the server sets the launchpad's hash, so the tab stays on
  its launchpad and its logon.
- Navigation for the guard. `SAP_ALLOW_TCODES` and `SAP_BLOCK_TCODES` are
  checked against the intent. An intent that carries a function code for a
  transaction (`DYNP_OKCODE`) counts as a write.
- When the user may not open the app, the answer holds the launchpad's
  error popup.
- On any other surface it is refused: open a transaction with `okcode`.

## Support by surface

| Verb | SAP GUI, scripting | SAP GUI, network reader (`diag`) | Web GUI | Fiori |
| --- | --- | --- | --- | --- |
| `set` | fields, text editors, table and grid cells (`row`, `col`) | fields, table cells, grid cells, dropdowns | fields, text editors, grid cells (`row`, `col`), calendars | inputs |
| `press` | buttons | buttons, toolbar keys | yes | yes |
| `click` | as `press` | yes | no: use `press` | as `press` |
| `key` | yes | yes | yes | its own key list |
| `select` | yes, also rows | yes, also rows and nodes | yes, also rows, menu paths | yes |
| `check` | yes | checkboxes, radio buttons | yes, also rows | yes |
| `combo` | yes | by the text shown | yes | yes |
| `okcode` | yes | yes | yes | in a Web GUI app inside the launchpad |
| `f4` | yes | fields | fields, dropdowns | yes |
| `focus` | yes | fields, grid rows, tree nodes | yes | no |
| `dblclick` | yes (F2) | yes | yes | yes |
| `tree` | yes | yes | yes | in a Web GUI app inside the launchpad |
| `grid` | `double`, `select`; needs `row` and `col` | yes | yes | in a Web GUI app inside the launchpad |
| `toolbar` | yes | yes | yes | in a Web GUI app inside the launchpad |
| `scroll` | up and down | up and down | up, down, sideways | tables and the page |
| `open` | no | no | no | yes |

Fiori hands `okcode`, `tree`, `grid` and `toolbar` to the Web GUI screen
when a Web GUI app is open inside the launchpad; otherwise they are
refused with the verbs Fiori takes.

### What the network reader refuses

The network reader (experimental) acts with the
keyboard and the mouse, and refuses an action when it cannot be sure what
the input does. Each refusal says what to do instead.

- `focus`, `f4`, `set` and `check` where their first click would press,
  tick or open something: on a push button, a toolbar button, a tab, a
  dropdown, a list line, or an element the reader cannot classify. `check`
  works only on checkboxes and radio buttons, `set` only on fields.
- `scroll`, and `sap_look` with `rows` that would scroll, while values typed
  with `set` or boxes ticked with `check` have not reached SAP: a page key
  would send them.
- Paging a table control whose first row on show has no plain field for
  the cursor.
- Sideways scrolling: the view already has every column SAP sent.
- A grid toolbar button named by part of its name, and a button found for a
  word rated safe whose own name says it writes.
- Anything SAP greys out, and any action on the logon screen.
- Any input when the session's window cannot be told apart from another
  SAP GUI window with the same title, or when it is minimized.
- `{BACK}` and other function codes of toolbar buttons and function keys:
  they are not in the traffic. Name the key by its text, or send the code
  through `okcode`.

The guard rates a network-reader action by the input it sends: a click on
a push button or on a box with a function code is judged as pressing it,
and a click on a button in a table-control row or on an element the reader
cannot classify is treated as a write.

## Key numbers

| Value | Default |
| --- | --- |
| Wait for SAP, SAP GUI scripting and Web GUI | 180 s |
| Wait for SAP, network reader | 60 s for SAP's answer; 3 s for SAP GUI to send a request (`SAP_DIAG_REQUEST_MS`); 60 ms of quiet after the answer (`SAP_DIAG_QUIET_MS`) |
| Wait for the UI5 app to be idle, Fiori | 30 s |
| `timeout` | in seconds, up to 600 |
| Actions per `actions` batch | 20 |
| Rows per `sap_look` with `rows` | 200 |
| Rows with `cols` and no `rows` | 50 (rows 0 to 49) |
| Compact view | rows of the longest controls cut beyond 20,000 characters |
| Client confirmation dialog | five minutes to answer |
| New session after `/o` | looked for during 5 s |
| Repair actions per step | 4 |
