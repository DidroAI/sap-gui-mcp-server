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
  would expose. Written by `python3 test/sapgui/fixtures/make.py`.
- `fixtures/expected/<session>.txt`: the full view that the Python bridge
  this surface was ported from (`sapgui.py`) prints for each session.
  Written by `make.py <path to sapgui.py>`, which runs the bridge's own
  `look()` on the world. `format.test.ts` holds the TypeScript formatter to
  these files, character for character.
- `fixtures/facts/<session>.json`: what `src/sapgui/ps/host.ps1` answers
  for each session, captured on Windows through the fake below.

## The fake SAP GUI

`fake-sapgui.wsc` is a Windows script component that serves `world.json` as
COM objects with the members of SAP GUI scripting the host uses. It needs no
install: the host binds it by path instead of the running SAP GUI when
`SAPGUI_MCP_FAKE` and `SAPGUI_MCP_FAKE_WORLD` are set (`e2e.mjs` sets them).
The host then talks to it exactly as to SAP GUI: late-bound COM calls from
Windows PowerShell 5.1. Actions leave a trace in the fake's status bar, so
the test sees what reached it.

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
warm look and takes a screenshot. It sends no action. To compare with the
Python bridge on the same screen, diff `full.txt` with the answer of the
bridge's `POST /look`: for the first session the two should be identical.
