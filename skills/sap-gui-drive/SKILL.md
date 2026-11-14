---
name: sap-gui-drive
description: Work in SAP screens with the sap-gui MCP tools — run a transaction, fill a screen, read a list, check a document in SAP GUI, Web GUI or Fiori. Use whenever a task means doing or checking something in an SAP system the user has open.
---

# Working in SAP screens

The `sap-gui` server works in the SAP sessions the user already has open,
as that user. It never logs on. Everything you do is what the user could
do by hand, under their authorisations.

## The loop

1. `sap_look` (or `sap_sessions` first when several systems are open). Read
   the header: transaction, program, screen and system tell you where you are.
2. One `sap_act` per step, on ids from the view. Each action answers with
   the new screen: read it before the next step instead of calling
   `sap_look` again.
3. After every action, read the **status bar** (`STATUS:` / `sbar` line).
   SAP reports errors (`E`), warnings (`W`) and successes (`S`) there; a
   red error means the step did not go through.

## How SAP screens behave

- **Fields take effect on Enter.** `set` only types; SAP checks the input
  and fills dependent fields after `{"do":"key","key":0}` (Enter). Fill all
  fields of a screen, then press Enter once.
- **Don't guess codes.** For a field that wants a code (order type, plant,
  company code), open its value help with `{"do":"f4","id":...}` and pick
  from the list rather than inventing a value.
- **Transactions:** `{"do":"okcode","value":"/nVA03"}` leaves the current
  transaction and starts another (unsaved input is lost);
  `/oVA03` opens it in a new session (SAP GUI).
- **Popups** are their own windows (`wnd[1]`, `wnd[2]`) above the screen.
  Answer them before anything else: the screen below does not react while
  a popup is open.
- **Lists:** ALV grids show rows with a column header once; open an entry
  with `{"do":"grid","id":...,"row":N,"col":"<column>","how":"double"}`.
  Trees: `{"do":"tree","id":...,"node":"<key>","how":"double"}`.
- **Back without saving:** F3 (`key 3`) goes back, F12 (`key 12`) cancels.
  If SAP asks whether to save, answer **No** unless the user asked you to
  save.

## Writing to SAP

Saving, posting, releasing or deleting changes the system for real. The
server's write setting decides what happens:

- **off** (default): such actions are refused. Tell the user what you
  would save and that writes are off.
- **confirm**: the action is held. Describe it to the user in plain words
  (what document, which values, which system) and call `sap_confirm` only
  after they say yes to that exact action.
- **on**: actions run. Still say what you saved, with the document number
  from the status bar.

Never work around the setting (for example by typing `/11` or a save
function code into the command field).

## When the view is not enough

`sap_screenshot` shows the window as an image: use it for charts, HTML
panels the text view marks as opaque, or to check a result visually.
