---
title: "Connect SAP GUI for Windows to an AI agent (SAP GUI scripting)"
description: "The SAP GUI scripting settings the server needs on your PC and on the SAP system (sapgui/user_scripting), and how it reads and drives SAP GUI for Windows."
---

# SAP GUI for Windows

On Windows, the server reads and drives SAP GUI for Windows through SAP GUI
scripting: the interface SAP GUI offers to scripts and test tools. It
lists every open connection and session, with system, client, user and
transaction, and uses the session you are in; the agent can switch with
`sap_use`.

Nothing else is installed: the server talks to SAP GUI through Windows
PowerShell 5.1 (`powershell.exe`), which comes with Windows. It starts one
PowerShell process on first use, keeps it running, and restarts it if it
stops.

Two settings must allow scripting, one in SAP GUI on your PC and one on the
SAP system. `doctor` checks both:

```sh
npx -y sap-ui-automation doctor
```

If scripting cannot be turned on for a system, the [network
reader](network-reader.md) reads SAP GUI without it (experimental), and
Web GUI in [Chrome](chrome.md) needs no scripting at all.

## 1. Turn scripting on in SAP GUI

In SAP Logon: **Options → Accessibility & Scripting → Scripting**.

- Tick **Enable scripting**.
- Untick **Notify when a script attaches to SAP GUI** and **Notify when a
  script opens a connection**. With them ticked, SAP GUI shows a dialog and
  waits for a click each time the server attaches.

Then restart SAP Logon.

SAP GUI keeps these settings in the Windows registry, under
`SAP\SAPGUI Front\SAP Frontend Server\Security` (values `UserScripting`,
`WarnOnAttach`, `WarnOnConnection`). A value an administrator set for the
whole machine (`HKLM`) wins over yours (`HKCU`); `doctor` says when a
setting comes from there, since you cannot change it in the options
dialog then. Ask your IT team in that case.

## 2. Allow scripting on the SAP system

The SAP system must allow scripting too, with the profile parameter
`sapgui/user_scripting = TRUE`. This is for your SAP basis team: they can
set it in transaction RZ11, and in the default profile to keep it after a
restart. Then log on again.

Test and QA systems often allow it; production systems often do not. When a
system does not, SAP GUI shows your session but scripting sees none of it:
`doctor` names the connection, and `sap_sessions` says that scripting is
off.

SAP has a few related parameters that a system may set as well. The server
does not read them, and `doctor` checks only the effect of
`sapgui/user_scripting`; we list them so you know what to ask basis about.
Check their exact meaning in SAP's documentation for your release:

| Parameter | What SAP documents it to do |
| --- | --- |
| `sapgui/user_scripting_per_user` | when TRUE, only users with the authorisation object `S_SCR` may use scripting |
| `sapgui/user_scripting_set_readonly` | when TRUE, scripts may only read: actions that change the screen fail |
| `sapgui/user_scripting_disable_recording` | when TRUE, SAP GUI's own script recorder is off (the server does not use it) |

## 3. Run the server as you

The server must run as the same Windows user as SAP GUI, in the same
desktop session, and not as administrator. Otherwise SAP GUI does not offer
its scripting object to it, and `doctor` says so.

PowerShell must run in Full Language mode, because the server's script calls
SAP GUI's COM objects. Where a Windows policy (AppLocker or App Control)
restricts scripts, `doctor` reports the mode it found. Ask your IT team to
allow the server's script (a rule for its folder, or for its publisher once
it is signed), or use Web GUI or Fiori in Chrome, which need no PowerShell.

## What `doctor` checks

For SAP GUI for Windows, `doctor` prints one line per check, a `✓` or a
`✗`, and for each `✗` what to change:

- PowerShell may run the host (a Windows policy does not restrict it);
- SAP GUI is running;
- scripting is on in SAP GUI;
- scripting is allowed on the SAP system, with the number of sessions it
  sees per connection;
- the notice "a script is attaching" is off;
- the notice "a script opens a connection" is off.

On macOS and Linux, SAP GUI for Windows is not checked: it runs only on
Windows.

## Working with sessions

- `sap_sessions` lists each session as `SAP GUI <connection>, session <n>`.
- `{"do":"okcode","value":"/oVA03"}` opens a transaction in a new session.
  The server follows it: the new session becomes the active one, and the
  previous one stays open. SAP allows at most six sessions per logon; if no
  new session appears within five seconds, the answer says so.
- A session of the same logon (same system, client and user) takes the
  number notation the other session already showed: the `NUMBERS` line of
  an `/o` session is known at once.
- A toolbar button marked `(menu)` opens a menu. `{"do":"toolbar","id":
  "<toolbar>","button":"<code>"}` answers the menu's entries;
  `"value":"<entry>"` chooses one. ME23N's document overview finds
  purchase orders this way (Selection variant, Purchase orders).
- The compact view leaves out what SAP GUI adds around the transaction
  and the Web GUI view does not have: the window's own line, the status
  bar's panes, SAP GUI's buttons for a new window, a shortcut and its
  settings, Enter in the main toolbar, a label repeated on the field beside
  it, and a selection screen's texts ("Material", "to") that its fields
  already carry. `sap_look` with `full` keeps them all, and every one can
  still be acted on.
- Ids are forgiving where agents slip: a field's id with another type in
  front (`ctxtRF05L-BELNR` for `txtRF05L-BELNR`) and a selection
  criterion's name (`MS_MATNR` for `MS_MATNR-LOW`) find the field; a
  table's column may be given as the legend writes it (`txtKONP-KBETR`).
- A click on an ALV grid's or a table control's row (`"do":"click"` with
  `row`) selects the row and puts the cursor on the cell.
- `set` into a field SAP keeps closed is refused with the reason: after an
  error or a warning, SAP opens only the fields its message is about.
- Typing into fields does not read the screen again: SAP GUI keeps typed
  text to itself until Enter, so a batch of `set` actions costs one read
  of the screen, not two per field.
- `sap_screenshot` asks SAP GUI for an image of the window. A minimised
  window gives none.
- An action waits up to 180 seconds for SAP, or its `timeout` (up to 600
  seconds).

## Limits

- SAP GUI for Java (macOS, Linux) has no scripting: on a Mac, use Web GUI
  or Fiori.
- HTML panels inside SAP GUI (such as SE80's object selector) cannot be
  reached by scripting: the view shows them as `html-viewer`. Use
  `sap_screenshot` to see them.
- Long lists were run live on SAP GUI 8.00 (ECC 6.0): an ALV grid of 162
  rows and a classic list of 501 lines, scrolled and read by row ranges.
  Record and replay were run live too ([Recording and replay](record-replay.md)).
- A list's view shows the rows on screen, numbered as cell ids count them;
  `sap_look` with `id` and `rows` numbers them in the whole list.
- The number notation is learnt from screens: until one shows an amount
  with decimals (`1.250,00`) or a grouped quantity (`9.983,000`, in a
  field, a grid or a tree), screens with numbers such as `40,000` say
  `NUMBERS unknown`.
- `GetObjectTree` (one call for a whole screen) crashed SAP GUI 8.00
  compilation 1 here, so the host reads control by control: a screen of
  about 430 controls (FB50 with its item table) takes about a second.
- Safe and commit words are known in a handful of logon languages; in
  others more actions are held ([Safety model](../concepts/safety.md)).
