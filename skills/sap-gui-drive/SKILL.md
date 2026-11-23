---
name: sap-gui-drive
description: Work in SAP screens with the sap-gui MCP tools — run a transaction, fill a screen, read a list, check a document in SAP GUI, Web GUI or Fiori. Use whenever a task means doing or checking something in an SAP system the user has open.
---

# Working in SAP screens

The `sap-gui` server ([sap-gui-mcp-server](https://github.com/DidroAI/sap-gui-mcp-server);
its tools are named `sap_*`, whatever name the server was added under) works
in the SAP sessions the user already has open, as that user. It never logs on. Everything you do is what the user could
do by hand, under their authorisations.

## The loop

1. `sap_look` (or `sap_sessions` first when several systems are open), or
   straight to `sap_act` `{"do":"okcode","value":"/nVA01"}` when the task
   names the transaction. Read the header: transaction, program, screen and
   system tell you where you are.
2. One `sap_act` call per **screen**: the fields you see and the key that
   sends them, as `{"actions":[{"do":"set",...},{"do":"set",...},{"do":"key","key":0}]}`.
   The batch ends at the first surprise (a failure, a popup, an E/W/A status,
   another screen, a write waiting for a yes) and the answer says
   `Ran k of n actions. Stopped: ...`. A step's `"expect"`
   (`{"screen":"4001"}`, `{"popup":true}`, `{"status":"W"}`) lets it go on
   through what you know comes. A write on a screen the batch reached after
   you sent it does not run unless its step says `"unseen": true`: read that
   screen first unless you are sure of it. An `okcode` submits on its own:
   send no Enter after it (a batch skips one that comes right after).
3. Each answer is the new screen: read it before the next step instead of
   calling `sap_look` again (a `sap_look` right after it, on the same screen,
   starts with "Unchanged since your last sap_act"). On the same screen it
   holds only what changed (`~` changed, `+` new, `-` gone, `=` context).
4. Read the **status bar** first (`STATUS E: ...`, or `sbar  status` in the
   view; toasts and popovers in Fiori). `E`: the step did not go through,
   correct the field it names. `W`: Enter accepts it. `S`: done, document
   numbers are there.

## How SAP screens behave

- **Fields take effect on Enter.** `set` only types; SAP checks the input
  and fills dependent fields after `{"do":"key","key":0}` (Enter). Fill all
  fields of a screen, then press Enter once.
- **Don't guess codes.** For a field that wants a code (order type, plant,
  company code), open its value help with `{"do":"f4","id":...}` and pick
  from the list rather than inventing a value.
- **Transactions:** `{"do":"okcode","value":"/nVA03"}` leaves the current
  transaction and starts another (unsaved input is lost);
  `/oVA03` opens it in a new session (SAP GUI). In a Fiori tab, open an app
  with `{"do":"open","app":"#PurchaseOrder-manage"}`; an okcode with an
  intent (`/nPurchaseOrder-manage`, `#X-y`) does the same, and `/n` goes to
  the launchpad's home page.
- **Popups** are their own windows (`wnd[1]`, `wnd[2]`) above the screen.
  Answer them before anything else: the screen below does not react while
  a popup is open.
- **Lists:** ALV grids show rows with a column header once; open an entry
  with `{"do":"grid","id":...,"row":N,"col":"<column>","how":"double"}`.
  Trees: `{"do":"tree","id":...,"node":"<key>","how":"double"}`.
  A cell of an input table or grid: `{"do":"set","id":<table>,"row":N,"col":"<column>","value":...}`.
  `"row"` is always the number the view prints ("row N:", counted in the
  whole table or list); the server scrolls to the row. A line of a classic
  list: `{"do":"dblclick","id":"usr","row":N,"col":<number in braces>}`.
- **Long lists** show the rows on screen and the total. Move them with
  `{"do":"scroll","id":...,"to":N}` (or `"next"`, `"prev"`, `"first"`,
  `"last"`); read a range with `sap_look` and `"id"`, `"rows": "100-150"`.
  Do not conclude from the rows on screen that an entry is missing.
- **Dropdowns** show their current entry and how many they have.
  `{"do":"combo","id":...}` without a key lists the entries; with
  `"key"` it chooses one.
- **Back without saving:** F3 (`key 3`) goes back, F12 (`key 12`) cancels.
  If SAP asks whether to save, answer **No** unless the user asked you to
  save.

## Writing to SAP

Saving, posting, releasing or deleting changes the system for real. The
server's write setting decides what happens:

- **off** (default): such actions are refused. Tell the user what you
  would have saved and that writes are off, then stop: do not look for
  another way.
- **confirm**: the client asks the user before the action runs. If they
  decline, stop and ask how to go on. If the answer says this client cannot
  ask the user, the write is refused: tell the user what you would have
  saved, and stop.
- **on**: actions run. Still say what you saved, with the document number
  from the status bar.

Never work around the setting (for example by typing `/11` or a save
function code into the command field).

When a write did not run (refused, declined or not asked), and you had
typed into the transaction or opened a document to change it, leave it
without saving: `{"do":"okcode","value":"/n"}`, or Back and the "leave
without saving" answer to SAP's question. That releases SAP's lock on the
document. Don't leave it open for the user to save by hand unless they ask.

## When the view is not enough

`sap_screenshot` shows the window as an image: use it for charts, HTML
panels the text view marks as opaque, or to check a result visually.
