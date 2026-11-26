# Surfaces

A surface is one kind of SAP screen the server can read and drive. There are
three, and the agent works with all of them through the same tools, the same
view format and the same actions.

| Surface | Name in `sap_sessions` | How the server reaches it | Runs on |
| --- | --- | --- | --- |
| SAP GUI for Windows | `sapgui` | SAP GUI scripting, through Windows PowerShell, and, experimental, SAP GUI's network traffic (the network reader); both by default, `SAP_GUI_METHOD` keeps to one | Windows |
| SAP GUI for HTML (Web GUI) | `webgui` | Chrome, through the DevTools protocol: a Chrome window the server starts, your Chrome with remote debugging, or your Chrome through the extension (`SAP_BROWSER`) | Windows, macOS, Linux |
| SAP Fiori | `fiori` | the same Chrome, through SAPUI5 in the page | Windows, macOS, Linux |

SAP GUI for Java (macOS, Linux) has no scripting and is not supported: on a
Mac, use Web GUI or Fiori.

## Which surfaces are looked for

`SAP_SURFACES` lists the kinds of session to look for, separated by commas.
The default is `sapgui,webgui,fiori` on Windows and `webgui,fiori`
elsewhere. An unknown name is an error at start.

SAP GUI for Windows can be read two ways: SAP GUI scripting, or the
network reader (`diag`),
which reads SAP GUI from its network traffic. By default both run:
`sap_sessions` lists what each one sees (a session read from the traffic
says "through the DIAG router"), and the agent works in the session it
needs. `SAP_GUI_METHOD=scripting` or `SAP_GUI_METHOD=diag` keeps to one,
for a setup where nobody watches the agent and the method must not change.

## How sessions are found

The server finds the sessions you have open, each time a tool needs them;
there is nothing to register.

- **SAP GUI for Windows (scripting):** SAP GUI scripting lists every open
  connection and session, with system, client, user and transaction. The
  session you are in comes first and is the active one; the agent can
  switch with `sap_use`. See [SAP GUI for Windows](../guides/sap-gui-windows.md).
- **SAP GUI for Windows (`diag`):** every connection that goes through the
  server's local SAProuter is listed, with each of its SAP GUI sessions.
  See [Network reader](../guides/network-reader.md).
- **Web GUI and Fiori:** the server works in the Chrome `SAP_BROWSER`
  names (by default a Chrome window it starts, the SAP window) and gives
  each tab one owner: a tab whose
  address contains `/sap/bc/gui/sap/its/webgui`, or that holds Web GUI's
  own controls, is Web GUI; a tab that runs SAPUI5 and is a launchpad is
  Fiori; any other tab is left alone. See [Chrome: Web GUI and
  Fiori](../guides/chrome.md).

A Web GUI app opened inside the Fiori launchpad is driven as part of the
Fiori tab. A Web GUI tab that moves to the launchpad belongs to the Fiori
surface from then on, and the reverse.

With `SAP_ALLOW_SYSTEMS` set, sessions of other systems are hidden, and
`sap_sessions` says how many were hidden ([Safety model](safety.md)).

## What differs between surfaces

The view and the actions are the same; a few things belong to one surface:

- `okcode`, `tree`, `grid` and `toolbar` need an SAP GUI screen: SAP GUI,
  Web GUI, or a Web GUI app opened inside the Fiori launchpad. On a plain
  Fiori app they are refused with the actions that work there.
- `open` opens a launchpad app by its intent, on Fiori only. `click` works
  on Fiori (and SAP GUI) as another name for `press`.
- The menu bar lists every entry with `sap_look` and `id: "mbar"` on Web GUI
  and with the `diag` method.
- `/oVA03` opens a new SAP GUI session, and the server follows it there.
- Fiori reports messages as toasts and popovers, SAP GUI and Web GUI in the
  status bar line.

Each guide lists what does not work yet on its surface:
[SAP GUI for Windows](../guides/sap-gui-windows.md#limits),
[Network reader](../guides/network-reader.md#limits),
[Chrome: Web GUI and Fiori](../guides/chrome.md#limits).
