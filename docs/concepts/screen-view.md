---
title: "The screen view: an SAP screen as text for an agent"
description: "How the server prints an SAP screen: a header, then one line per control with SAP's own id, type, label, value and state."
---

# The screen view

What does the agent see? The server reads the screen the way SAP models it
and prints it as text: a header that says where the session is, then one
line per control, with SAP's own id, its type, the label next to it, its
value and its state.

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

(Web GUI, transaction VA01.) SAP's messages appear as a `sbar  status`
line. Checkbox states, tree nodes, ALV grid cells, table controls and
popups, with what is behind them, are all part of the view. A popup is a
window of its own (`WINDOW wnd[1]`) after the main one. The ids are
explained in [Ids and handles](ids.md).

## Asking for a view

`sap_look` returns the view of the active session (or of `session`):

| Argument | Gives |
| --- | --- |
| none | the whole screen, compact |
| `full: true` | every id, every column, each toolbar button and its key on a line of its own (larger) |
| `diff: true` | only what changed since the view the agent got last |
| `id` | one control, whole: all the entries of a dropdown, all the rows read of a grid, table, tree or list; `id: "mbar"` lists every menu entry |
| `id` and `rows: "120-180"` | those rows of a grid, table control, tree or list, counted from 0; the control is scrolled there (200 rows at most per call) |
| `id` and `cols: "VBELN,NETWR"` | only these columns of a grid or table control, by id or title; without `rows`, the first 50 rows |

`sap_look` with an `id` reads one control and does not count as a view of
the screen: the next diff is still counted from the last whole view.

## What an answer holds

`sap_act` answers with a line that says what was done, then the screen.
When the action left the session on the same screen (same transaction,
program, screen number and windows) and the changes are clearly shorter
than the screen, the answer holds the changes only:

```
set wnd[0]/usr/ctxtVBAK-VKORG

CHANGED 1 of 18 lines (same screen; sap_look shows all of it):
~ ctxtVBAK-VKORG  field  Sales Organization = "1000"  (edit)
```

| Mark | Line |
| --- | --- |
| `~` | a line whose content changed, as it is now |
| `+` | a new line |
| `-` | a line that is gone |
| `=` | an unchanged line, for context: the control whose rows follow |

Everything not in the answer is as the agent last saw it.

- A control whose rows changed for the most part (a list that was scrolled)
  is given whole.
- The whole screen is always sent on a new transaction, a new screen or a
  new popup, and when the changes are not much shorter than it (a diff
  longer than 60% of the view is not used).
- After a popup closes, the changes are counted from the view the agent got
  before the popup, and the header says so.
- When the status bar holds an error, a warning or a termination, that is
  said first, right under the action's line, with what to do about it
  (`STATUS E: ...  (error: correct the input it names, then Enter)`), and
  it is added at the end of a diff that left it out.

`sap_look` always shows the whole screen. `"full": true` on `sap_act` sends
the whole screen for one action, and `SAP_VIEW=full` for all of them.

### What it costs

On one read-only flow of 51 steps on Web GUI (VA01 without saving, VA03,
VA05, SE16N, SE16, MM03;
[`test/dev/soak.ts`](https://github.com/DidroAI/sap-ui-automation/blob/main/test/dev/soak.ts),
one run, tokens counted with the Anthropic `count_tokens` API), the answers
cost 58k tokens in all, and 73k with `SAP_VIEW=full`, where every action
answers with the whole screen. Typing into a field answers with about 50
tokens instead of the screen.

## What the compact view folds, and how to get it

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
| The menu bar is one line with the menus' names | Web GUI (and the `diag` method): `sap_look` with `id: "mbar"` lists every entry with its id |

## Long lists

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

An agent should not conclude from the rows on screen that an entry is
missing.

Limits of long lists:

- Lists scroll down and up, not sideways: a grid wider than the screen
  shows the columns SAP has drawn. A table control's columns scroll with
  `"right"` and `"left"`.
- Web GUI draws only the tree nodes in view; a node further down is reached
  by scrolling the tree first.
- On Fiori, `sap_look` with an `id` reads that one control whole (also the
  part of a table below the fold); `rows` is not used there.
- On SAP GUI for Windows (scripting), long lists were run on SAP GUI 8.00
  against ECC 6.0: an ALV grid of 162 rows and a classic list of 501 lines
  ([SAP GUI for Windows](../guides/sap-gui-windows.md#limits)).

## When the text is not enough

`sap_screenshot` returns a PNG of the session's window or tab: for charts,
HTML panels the text view cannot read, or to check a result by eye.
