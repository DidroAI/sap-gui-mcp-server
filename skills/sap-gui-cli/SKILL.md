---
name: sap-gui-cli
description: Work in SAP screens from the shell with the sap-gui CLI — run a transaction, fill a screen, read a list, check a document in SAP GUI, Web GUI or Fiori. Use when a task means doing or checking something in an SAP system the user has open and the sap_* MCP tools are not available but a shell is.
---

# Working in SAP screens with the `sap-gui` CLI

`sap-gui` (from [sap-gui-mcp-server](https://github.com/DidroAI/sap-gui-mcp-server);
`npx sap-gui-mcp-server <command>` works too) works in the SAP sessions the
user already has open, as that user. It never logs on.

Each call prints a few short lines and the path of a file with the whole
screen. **Read the printed lines; open the file only when you need the
screen** (to find an id, read values, see a list).

```
$ sap-gui act set ctxtVBAK-AUART OR
did set
CHANGED 1 of 48 lines (same screen; sap_look shows all of it):
screen: .sap-gui/screens/7-act.txt
```

## The loop

1. `sap-gui look` (or `sap-gui sessions`, then `sap-gui use <n>`, when
   several are open). The printed header says where you are: transaction,
   program, screen, system. Read the screen file once for the ids.
2. One `sap-gui act` per step, on ids from the screen. It prints the action's
   note, then where the screen is now: the new screen's header, or
   `CHANGED n of m lines` when it is the same screen (the file then holds
   only the changes: `~` changed, `+` new, `-` gone, `=` context).
3. Read the **STATUS** line when there is one: `STATUS E:` is an error (the
   step did not go through), `W:` a warning (Enter accepts it), `A:` an
   abort. A success shows as the status bar line (`sbar  status  S: ...`).

A long run of steps on one screen: `sap-gui look --print` prints all of it.

## Commands

```
sap-gui sessions                       the open sessions; * marks the active one
sap-gui use <n|id|system|tcode>        make one the active session
sap-gui look [--full] [--diff]         the screen (file); --print prints it
sap-gui look --id <id> [--rows 100-150] [--cols VBELN,NETWR]   one control whole, a range of rows
sap-gui act '<json>' [--full]          one action (below)
sap-gui confirm <token>                run a held write, only after the user said yes
sap-gui screenshot                     a PNG (charts, HTML panels the text cannot show)
sap-gui record start "<name>" | assert '<json>' | stop | list | status   a repeatable test
sap-gui replay <file>                  run a recorded test again, no model
sap-gui daemon status | stop
```

Every command takes `--session <ref>`. Exit codes: 0 done, 1 error or
refused (the message is on stderr), 2 usage, 3 held for confirmation.

## Actions

Quote JSON for the shell with single quotes. Shorthands for the common ones:
`act set <id> <value>`, `press <id>`, `key <n>`, `okcode </nVA03>`,
`select <id>`, `check <id> true|false`, `combo <id> [key]`, `f4 <id>`,
`dblclick <id>`, `scroll <id> <row|next|prev|first|last>`.

```
{"do":"set","id":"ctxtVBAK-AUART","value":"OR"}     type into a field
{"do":"set","id":"<grid>","row":0,"col":"SEATSOCC","value":"12"}   a cell of an input grid
{"do":"press","id":"btn[8]"}                        a button (btn[N] is function key N)
{"do":"key","key":0}                                0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel
{"do":"select","id":"tabpT\\08"}                    tab, radio button, menu entry, list item
{"do":"select","id":"<table or grid>","row":2}      select a row
{"do":"check","id":"...","value":true}              checkbox
{"do":"combo","id":"...","key":"PROG"}              dropdown entry; without key: lists the entries
{"do":"okcode","value":"/nVA03"}                    the command field (the only way to type into it)
{"do":"f4","id":"..."}                              value help
{"do":"grid","id":"...","row":0,"col":"VBELN","how":"double|select|cell"}
{"do":"tree","id":"...","node":"<key>","how":"double|select|expand|collapse"}
{"do":"toolbar","id":"...","button":"<id>"}
{"do":"scroll","id":"...","to":120}                 a row from 0, or next/prev/first/last
{"do":"open","app":"#SalesOrder-manage"}            Fiori: a launchpad app by its intent
```

## How SAP screens behave

- **Fields take effect on Enter.** `set` only types; fill the screen, then
  `act key 0` once.
- **Don't guess codes**: open the value help (`act f4 <id>`) and pick.
- `/nVA03` leaves the transaction (unsaved input is lost); `/oVA03` opens a
  new session (SAP GUI).
- **Popups** (`wnd[1]`) come first: the screen below does not react until
  they are answered.
- **Long lists** show the rows on screen and the total: scroll, or
  `look --id <id> --rows 100-150`. Do not conclude an entry is missing from
  the rows on screen.
- **Back without saving**: `act key 3` (F3) or `act key 12`; when SAP asks
  whether to save, answer No unless the user asked to save.

## Writing to SAP

Saving, posting, releasing, deleting change the system. The user's
`SAP_WRITE` decides: `off` (default) refuses; `confirm` holds the action and
exits 3 with `sap-gui confirm <token>`: describe the action to the user in
plain words and run it only after they say yes to that exact action; `on`
runs it. Never work around the setting (no save codes in the command field).

The CLI keeps a background daemon per directory, started on the first call
with that call's `SAP_*` settings. A call with other settings is refused:
`sap-gui daemon stop` first, and only when the user asked for the new
settings.
