# Ids and handles

Every line of the view starts with the id of its control. The agent acts on
those ids, as the view shows them.

## Scripting ids and handles

SAP GUI scripting names every control by a path from the window down, such
as `wnd[0]/usr/ctxtVBAK-AUART`. The first letters of the last segment say
what the control is (`ctxt` a field with value help, `txt` a text field,
`btn` a button, `chk` a checkbox, `tabp` a tab, `cntl` a container), and
the rest is SAP's name for it. Web GUI screens are given the same ids, so
an agent sees one kind of id on SAP GUI and Web GUI.

The compact view shortens each id to a **handle**: the last segment when it
is unique on the screen (`ctxtVBAK-AUART`), else the last segment with as
few earlier ones as make it unique (`cntlGRID1/shell`,
`cntlSPLITTER_CONTAINER/shellcont[1]/shell`, `tbar[1]/btn[3]`). A toolbar
button is `btn[N]`, and N is its function key: `btn[8]` is F8, so pressing
it and sending key 8 do the same.

Every action takes a handle, a full id, or a field's SAP name
(`VBAK-AUART`).

- An id that names several controls is refused with the list of them. The
  server does not pick one.
- An id that is not on the screen is refused. If the screen is not the one
  the agent saw last, the answer holds the screen it is on, so an id from
  an earlier screen fails with the current screen in the same answer.

`sap_look` with `full: true` prints the full id of every control.

## Ids inside lists

- A grid's rows are addressed by the grid's id with `row` (counted from 0)
  and `col` (a column id from the grid's line, such as `VBELN`).
- A table control's cells and a classic list's cells (`lbl[col,row]`) count
  their rows from the first row on screen, as scripting does: after a
  scroll, the same cell id names another row. The view says where the list
  is scrolled to (`first 60`).
- A tree node is addressed by the tree's id and the node key the view shows
  as `{node <key>}`.
- Buttons that differ only by their field share a line in the compact view:
  `btn%_S{VBELN,AUART}_%_APP_%-VALU_PUSH` stands for
  `btn%_SVBELN_%_APP_%-VALU_PUSH` and `btn%_SAUART_%_APP_%-VALU_PUSH`.
- A menu entry is `menu[...]` under `mbar`; `sap_look` with `id: "mbar"`
  lists every entry with its id (Web GUI and the `diag` method).

## The command field

The command field (`okcd`, Web GUI's `ToolbarOkCode`) takes commands
through `{"do":"okcode"}` only. `set`, `focus` or any other action on the
field itself is refused, on every surface, so that a command cannot go
round the guard.

## Fiori

Fiori controls are named by their SAPUI5 ids. The compact view shortens an
id to its shortest tail, cut at `--` or `::`, that no other control's id
ends with; `full: true` prints the whole id. A launchpad app is opened by
its intent (`#SalesOrder-manage`), not by an id; see [Chrome: Web GUI and Fiori](../guides/chrome.md#opening-a-fiori-app).

## The network reader

Without scripting (`SAP_GUI_METHOD=diag`) there are no scripting ids in the
traffic. Controls go by SAP field names (`VBAK-VBELN`), function codes in
braces (`{HEAD}`), button texts (`Back`), `FIELD[n]` table cells and
`@row,col` positions; a scripting id written nearly right is still taken
when it means one thing. See [Network reader](../guides/network-reader.md#ids).
