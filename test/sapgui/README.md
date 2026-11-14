# Tests of the SAP GUI for Windows surface

SAP GUI scripting is COM and only exists on Windows, so the surface is tested
in three layers.

| What | Where it runs | How |
| --- | --- | --- |
| Text view, id resolution, commit rule, surface, host process handling | anywhere | `bun test test/sapgui` |
| The built server, its PowerShell host and COM, without SAP GUI | Windows | `node test/sapgui/e2e.mjs` |
| The same against the SAP GUI that is open (reads only) | Windows desktop session | `node test/sapgui/e2e.mjs --real` |

## Fixtures: a made-up SAP GUI

`fixtures/make.py` defines a synthetic SAP GUI: one connection with eight
sessions, each on one kind of screen (an initial screen with fields, an
overview with tabs and a table control, a tree with a text editor, an ALV
list, a column tree next to an HTML viewer, a value-help popup, a popup that
asks whether to save, and SAP Easy Access), and a second connection whose
server does not allow scripting. No data from a real system.

- `fixtures/world.json`: that world as the object tree SAP GUI scripting
  would expose. Written by `python3 test/sapgui/fixtures/make.py` (Python 3,
  standard library only).
- `fixtures/facts/<session>.json`: what the PowerShell host
  (`src/sapgui/ps/`) answers for each session, captured on Windows through
  the fake below. To renew one after a change to the host, send the host a
  `screen` request for that session and save the `result`.
- `fixtures/expected/<session>.txt`: the full text view of each session, in
  the format `src/sapgui/format.ts` describes. `format.test.ts` holds the
  formatter to these files, character for character, so a change of format
  shows as a diff a person can read. After a change that is meant, write
  them again with `UPDATE_EXPECTED=1 bun test test/sapgui/format.test.ts`
  and review the diff.

## The fake SAP GUI

`fake-sapgui.wsc` is a Windows script component that serves `world.json` as
COM objects with the members of SAP GUI scripting the host uses. It needs no
install.

The shipped host (`src/sapgui/ps/host.ps1`) has no switch for it: it reaches
SAP GUI only as the object named `SAPGUI` in Windows' running object table.
The tests use `fake-host.ps1` instead, a test-only script that loads the
shipped functions (`src/sapgui/ps/host-lib.ps1`) and replaces the one that
fetches SAP GUI's object (`Get-SapGui`) with one that binds the fake.
`e2e.mjs` runs the built server in its own process on that host. Every other
line it exercises is the shipped code: late-bound COM calls from Windows
PowerShell 5.1. Actions leave a trace in the fake's status bar, so the test
sees what reached it.

`fake-host.ps1` and the fake are not in the published package (`files` in
`package.json` lists `dist` only).

The fake grid shows twenty rows from its `FirstVisibleRow`, and the fake
table control has a `VerticalScrollbar`, so `e2e.mjs` also scrolls a grid,
reads a range of rows and lists a dropdown's entries through the shipped
host. Those checks, and the host's scroll code they exercise, were written
on Linux and have not been run on Windows yet: run `node test/sapgui/e2e.mjs`
there before relying on them.

What the fake cannot show: how the real SAP GUI objects behave (timing,
errors, the `HardCopy` image format). That is what `--real` is for.

## Against a real SAP GUI

In the desktop session where SAP GUI is open and logged on:

```
bun run build
set E2E_FULL_OUT=full.txt
node test\sapgui\e2e.mjs --real
```

It lists the sessions, prints the compact view of the active one, times a
warm look and takes a screenshot. It sends no action. With `E2E_FULL_OUT`
it also writes the full view to that file, to read next to the screen.
