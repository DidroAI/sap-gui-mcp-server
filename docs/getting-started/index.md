# Introduction

sap-gui-mcp-server is an [MCP](https://modelcontextprotocol.io) server that
lets an agent (Claude, Codex, Cursor and other MCP clients) **see and drive
the SAP screens you already have open**:

- **SAP GUI for Windows**, through SAP GUI scripting (or, experimental,
  without scripting, by reading SAP GUI's network traffic);
- **SAP GUI for HTML (Web GUI)** in Chrome;
- **SAP Fiori** in Chrome, including Web GUI apps opened inside the
  launchpad.

It finds your open sessions by itself and works in them as you, under your
SAP authorisations. It never logs on and never stores a password. Actions
that may write to SAP are refused unless you allow them.

> Status: 0.1.0, the first public version. It works on real systems, but
> parts are young: each guide lists the limits of its surface. MIT licence.

## Requirements

- **Node.js 22 or later** on the machine where your MCP client runs.
  TypeScript tests and configs (`*.sap.ts`, `sap.config.ts`, `sap_code_test`)
  want **22.18 or later**, which loads TypeScript without a flag. The test
  command also works from 22.6 (it re-runs itself with
  `--experimental-strip-types`) and `sap_code_test` from 22.13; on an older
  Node they say to use 22.18 instead of failing with "Unknown file
  extension".
- At least one of these, depending on how you use SAP:

| Surface | You need |
| --- | --- |
| SAP GUI for Windows | Windows, SAP GUI for Windows, scripting enabled in SAP GUI **and** allowed on the SAP system ([details](../guides/sap-gui-windows.md)) |
| SAP GUI for Windows without scripting (experimental) | Windows, SAP GUI for Windows, a connection entry you can edit in SAP Logon, no SNC encryption ([details](../guides/network-reader.md)) |
| Web GUI | Chrome 144 or later (or Edge) with remote debugging allowed, and a Web GUI tab open and logged on: its address contains `/sap/bc/gui/sap/its/webgui` ([details](../guides/chrome.md)) |
| Fiori | The same Chrome, and a Fiori launchpad tab open and logged on (for example `/sap/bc/ui2/flp`) |

Web GUI and Fiori work from Windows, macOS and Linux. SAP GUI for Java
(macOS, Linux) has no scripting and is not supported.

## What the agent sees

The server reads the screen the way SAP models it and prints one line per
control, with SAP's own ids, the label next to each field, its value and
whether it can be edited:

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

The agent acts on those ids with one small set of JSON actions, the same on
every surface. After an action that leaves it on the same screen, it gets
only what changed:

```
set wnd[0]/usr/ctxtVBAK-VKORG

CHANGED 1 of 18 lines (same screen; sap_look shows all of it):
~ ctxtVBAK-VKORG  field  Sales Organization = "1000"  (edit)
```

[The screen view](../concepts/screen-view.md) explains every part of it.

## Next

- [Install in your client](installation.md): add the server to Claude Code,
  Codex, Claude Desktop or Cursor.
- [Set up with your agent](setup-prompt.md): a prompt that has your agent
  install and check everything for you.
- [Your first session](first-session.md): open SAP, ask, and see what the
  agent does.
