---
name: sap-gui-drive
description: Drives SAP screens through the sap-ui-automation MCP tools (sap_look, sap_act, sap_sessions, sap_logon). Runs transactions, fills screens, reads lists and ALV grids, checks documents and works in several sessions at once, in SAP GUI for Windows, Web GUI and Fiori. Use when a task means doing or checking something in an SAP system (a transaction code such as VA01 or ME23N, an order, a material, a Fiori app) and the sap_* tools are available.
---

# Driving SAP screens with the sap_* tools

The tools work in the SAP sessions the user has open, as that user and
under their authorisations. They come from the `sap-ui-automation` MCP
server (`sap-ui-automation:sap_look`; the tool names are the same under any
server name). Each tool's description lists its actions and fields. This
skill gives the order of work and how SAP behaves.

## One screen, one call

1. **Find the screen.** `sap_look`, or straight to
   `{"do":"okcode","value":"/nVA03"}` with `sap_act` when the task names
   the transaction. With several sessions open, `sap_sessions` first.
2. **Send the whole screen in one `sap_act`**: the fields you see, then the
   key that submits them.

   ```json
   {"actions":[
     {"do":"set","id":"ctxtVBAK-AUART","value":"OR"},
     {"do":"set","id":"ctxtVBAK-VKORG","value":"1000"},
     {"do":"key","key":0}]}
   ```

3. **Read the answer, not the screen again.** The answer is the new screen
   (or only the lines that changed). `Ran k of n actions. Stopped: ...`
   means the batch ended early, at a popup, a status message or another
   screen: go on from the screen it shows with the actions that did not run.
4. **Read the status bar first** (`STATUS E: ...`; toasts in Fiori).
   `E`: nothing went through, correct the field it names. `W`: Enter
   accepts it, when the warning is acceptable for the task. `S`: done.
5. **Report** what you read or saved, with the document number from the
   status bar.

A write (Save, Post) on a screen the batch reached after you sent it does
not run. Read that screen in the answer, then send the write. Mark the step
`"unseen": true` only when you know the screen.

## How SAP screens behave

- **Fields take effect on Enter.** `set` only types. SAP checks the input
  and fills dependent fields on Enter, so fill the screen, then press Enter
  once.
- **Do not guess codes** (order type, plant, company code): open the value
  help with `{"do":"f4","id":...}` and pick from its list.
- **`/n<tcode>` drops unsaved input** in the current transaction.
- **Popups come first.** A `WINDOW wnd[1]` blocks the screen below until it
  is answered.
- **A list shows the rows on screen and the total.** Never conclude that an
  entry is missing from the rows on screen: read the others with `sap_look`
  and `"id"`, `"rows":"100-150"`. `"row"` in an action is the number the
  view prints.
- **Numbers follow the user's notation.** Trust the `NUMBERS` line of the
  view: with `NUMBERS 1.234,56`, "1.000" is one thousand. When it says
  `unknown`, find the notation before you read or type an amount.
- **Leaving without saving:** Back (`key 3`) or Cancel (`key 12`). When SAP
  asks whether to save, answer No unless the user asked you to save.
- **Fiori:** open an app with `{"do":"open","app":"#PurchaseOrder-manage"}`.
  The okcode `/n` goes to the launchpad's home page.

## Several sessions at once

Use one session per independent part of a task (look up one order while
creating another, the same check in two systems).

1. **Get a session per part.**
   - `{"do":"okcode","value":"/oVA03"}` opens another session of the same
     logon (SAP GUI and Web GUI). Send it on its own: inside `actions` it
     is refused.
   - `sap_logon` with `"newSession": true` opens a new window with a logon
     of its own, on the same system or another. Only servers set up with
     the Chrome extension have `sap_logon`.

   The new session becomes the active one.
2. **Wait until it is verified.** Use a session when the `sap_logon` answer
   says `verified`, or `sap_sessions` lists it with its system, client and
   user. A Web GUI tab marked "not verified" is still loading or shows a
   popup: call `sap_sessions` again before you work in it.
3. **Pass `session` on every call**, with the id from the answer. Never rely
   on the active session. Calls on different sessions run at the same time,
   calls on one session run in order.
4. **Send the independent calls together**, then check each answer against
   its own part (transaction, document number) and report each part as it
   finishes.

A logon has a limit of sessions (6 unless the system sets another). When
`/o` answers that the logon has all the sessions it allows, answer SAP's
popup, then reuse a session you no longer need or open another logon with
`sap_logon` and `"newSession": true`. Do not send `/o` again.

## Logging on

Without `sap_logon` the server never logs on: ask the user to open SAP.
With it, log on only to a system `sap_systems` lists. When `sap_logon`
stops (wrong password, locked user, SAP asking about other logons), tell the
user what it says. Never retry on your own and never ask for a password.

## Writing to SAP

Saving, posting, releasing and deleting change the system for real. The
user's write setting decides what happens, and `sap_act` says which one
applies:

- **off** (default): the action is refused. Tell the user what you would
  have saved and stop.
- **confirm**: the client asks the user before the action runs. If they
  decline, ask how to go on. A client that cannot ask gets the action
  refused, as under off.
- **on**: the action runs. Say what you saved, with the document number.

Save with `{"do":"key","key":"Save"}` on every surface (in Web GUI the
server presses the toolbar's Save button for it).

Never work around the setting, for example with a save code in the command
field or another route to the same change. The setting is the user's
decision, not an obstacle.

When a write did not run and you had typed into the transaction or opened a
document to change it, leave without saving: `{"do":"okcode","value":"/n"}`,
or Back and No to SAP's question. This releases SAP's lock on the document.
Leave it open only when the user asks.
