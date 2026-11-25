# Chrome: Web GUI and Fiori

SAP GUI for HTML (Web GUI) and SAP Fiori are read and driven in the Chrome
you already use, through Chrome's remote debugging connection. This works
from Windows, macOS and Linux, and needs nothing on the SAP system.

## Allow remote debugging

In Chrome 144 or later:

1. Open `chrome://inspect/#remote-debugging`.
2. Tick **Allow remote debugging for this browser instance**.
3. Run `npx -y sap-ui-automation doctor`. Chrome asks you to allow the
   connection: click **Allow**. You have 45 seconds.

Chrome asks for each new connection. The server keeps one connection open
while it runs, so Chrome asks again only when the server connects anew (it
was restarted, or the connection dropped).

## How the server finds Chrome

The server attaches to the Chrome you are using, in this order:

1. `SAP_CHROME_CDP`, if you set it, e.g. `http://127.0.0.1:9222`. Nothing
   else is tried then.
2. Your running Chrome, once you allow remote debugging as above. Chrome
   stable is tried first, then Chrome beta, then Microsoft Edge. Chrome
   then writes its port to a file named `DevToolsActivePort` in its profile
   folder, and the server reads it there.

The server does not attach to port 9222 by itself: a browser listening
there may belong to another tool (a test runner, another agent). One
exception: on macOS, privacy protection may stop the app that runs the
server from reading Chrome's `DevToolsActivePort` file. The server then
uses port 9222 only when Chrome's or Edge's own process listens there.
Otherwise `doctor` asks you to give that app (Terminal or iTerm for
`doctor`; Claude, Codex or your editor for the MCP server) Full Disk Access
in System Settings → Privacy & Security, and to restart it.

### A Chrome started with a debugging port

To use a Chrome started with `--remote-debugging-port`, name it with
`SAP_CHROME_CDP`. Since Chrome 136 that switch only opens the port together
with `--user-data-dir`, pointing to a directory other than Chrome's default
one:

```sh
chrome --remote-debugging-port=9333 --user-data-dir="$HOME/chrome-sap"
SAP_CHROME_CDP=http://127.0.0.1:9333 npx -y sap-ui-automation sessions
```

This is also the way for a Chrome older than 144, which has no switch in
`chrome://inspect`.

### Microsoft Edge

Edge (also Chromium) is found the same way, after Chrome stable and beta,
and is likely to work. Firefox and Safari are not supported.

## Use your everyday Chrome with the extension

Instead of remote debugging, the server can reach your Chrome through the
**UI Automation for SAP** extension: no `chrome://inspect`
switch, your normal profile with its SSO, and only the tabs of the SAP
systems you register are shared. The extension also keeps your systems'
logons: the agent can say "log on to ECC Dev", and the extension types the
password into SAP's logon page itself. The agent and the server never see
it.

1. `npx -y sap-ui-automation extension install` copies the extension to
   `~/sap-ui-automation-extension` and installs its helper (pairing in one click,
   passwords in your keychain). In Chrome, open `chrome://extensions`, turn
   on **Developer mode**, click **Load unpacked** and pick that folder.
   Pin the icon (puzzle piece, then the pin), and restart Chrome once if it
   was open during the install.
2. Click the UI Automation for SAP icon: it opens a side panel beside the
   page. Click **Pair**.
3. Open your SAP system in a tab and click **Add this SAP page** in the panel. Add
   user and password if the extension should log on for you.
4. Add `"SAP_BROWSER": "extension"` to the `env` of sap-ui-automation in
   your agent's settings, and restart the agent app. The agent then also
   has `sap_systems` (your registered systems) and `sap_logon` (open one and
   log on).

The side panel shows what the agent does in SAP, step by step, and when it
waits for your yes to save. While the server works in a tab, Chrome shows
"UI Automation for SAP started debugging this browser". Clicking **Cancel**
there stops the sharing until you click **Share again** in the side panel.
`npx -y sap-ui-automation extension uninstall` removes the helper and the
saved passwords. See
[extension/README.md](https://github.com/DidroAI/sap-ui-automation/blob/main/extension/README.md)
for what happens on a wrong password or a locked user, where passwords are
kept, permissions, IT deployment and limits. SAP is a trademark of SAP SE;
the extension is not affiliated with SAP.

## Which tabs are SAP's

Each tab has one owner, decided in one place:

- **Web GUI:** the address path contains `/sap/bc/gui/sap/its/webgui`, or
  the page holds Web GUI's own controls;
- **Fiori:** SAPUI5 runs in the page, and it is a launchpad: an address
  under `/sap/` (`/sap/bc/ui2/flp`), or the launchpad shell (`sap.ushell`)
  in the page, as on SAP BTP where the address says nothing;
- any other tab is left alone. Only `http` and `https` pages are looked
  at, never `chrome://` pages or extensions.

A page that merely runs SAPUI5 is not taken for Fiori. A Web GUI tab that
moves to the launchpad belongs to Fiori from then on, and the reverse.

The server reads system, client and user from the page, and `sap_sessions`
shows each tab's origin. Chrome does not tell a tab's position, so tabs are
named by their title.

## What remote debugging gives away

Remote debugging gives the server (and so the agent using it) access to
every tab of that browser, not only SAP tabs. The server only reads tabs it
recognises as SAP, but:

- consider a separate Chrome profile for SAP work;
- set `SAP_ALLOW_ORIGINS` to look only at your SAP hosts, for example
  `SAP_ALLOW_ORIGINS=https://myhost:44300`. Tabs of other origins are then
  not read at all.

Closing the server never closes your browser: it only disconnects. Dialogs
the page opens itself (such as "Leave site?") stay for you to answer. See
also [Security and data handling](../security.md).

## Web GUI

Web GUI shows SAP GUI screens in the browser, and the server reads them as
it reads SAP GUI for Windows: the same view, ids and actions. Open a Web GUI
tab and log on; its address contains `/sap/bc/gui/sap/its/webgui`.

- **Background tabs.** Chrome draws a tab that is not in front about once a
  second, and hands it clicks and keys just as slowly. The server notices
  and waits longer (two to three seconds per action instead of one). It
  works, but a tab in front, or a window of its own, is faster.
- **Files.** Web GUI keeps a file that SAP writes "to a local file" (List →
  Export → Local File) inside the browser. The server copies it to
  `SAP_DOWNLOAD_DIR` (default: `downloads` in `SAP_RECORD_DIR` when that is
  set, else `./sap-downloads`), and the answer of the action names the
  copy.
- **Menus.** `sap_look` with `id: "mbar"` lists every menu entry with its
  id.
- **When SAP does not answer.** An action waits up to 180 seconds (or its
  `timeout`, up to 600), then says that SAP is still working. If the
  connection to SAP drops, the action says that the request failed; the
  page then needs a reload. A session that timed out shows as a `WINDOW
  browser` with a note.

## Fiori

Open the Fiori launchpad (for example `/sap/bc/ui2/flp`) and log on.

### Opening a Fiori app

`{"do": "open", "app": "#SalesOrder-manage"}` opens a launchpad app by its
intent: the part of the app's address after `#`, with parameters if you
need them (`"#SalesOrder-display?SalesOrder=4711"`). The server sets the
launchpad's hash, as a bookmark of the app does, so the tab stays on the
launchpad it is on and on its logon; a URL is refused.

Opening an app is navigation for the guard, and `SAP_ALLOW_TCODES` and
`SAP_BLOCK_TCODES` are checked against the intent before it is opened. An
intent that carries a function code for a transaction (`DYNP_OKCODE`)
counts as a write. When the user may not open the app, the launchpad says
so in a popup, and the answer holds it.

### Working in an app

- `press` and `click` both press a control; `set`, `select`, `check`,
  `combo`, `key`, `f4` and `scroll` work as on the other surfaces.
- `key` `Back` presses the launchpad's back button and never leaves the
  launchpad.
- `sap_look` with an `id` reads that one control whole, also the part of a
  table below the fold; `rows` is not used on Fiori.
- `scroll` scrolls a table or the page when the view ends with `SCROLL`.
- SAP's messages appear as toasts and popovers, not in a status bar.
- A Web GUI app opened inside the launchpad is read and driven like Web
  GUI, inside the Fiori tab; `okcode`, `tree`, `grid` and `toolbar` work
  there. The transaction lists do not check it by its transaction code.
- In a draft-enabled app, typing into a field saves the draft on the
  server at once. The guard does not count that as a write; activating the
  draft (Save, Create) is one.

### Logon and password pages

A tab at a launchpad address that shows no launchpad (SAP's logon page, its
page to change the password, a tab that does not answer) is listed by
`sap_sessions` with a title that says so; a look names the page, and every
action there is refused: you have to finish it yourself.

### Waits

The server waits for Fiori to be idle after each action: busy indicators
and UI5's own test support (RecordReplay). `SAP_FIORI_WAIT=busy` waits for
busy indicators only, which is faster.

## What `doctor` checks

- Chrome: which browser it attached to, its version, and how;
- the origins `SAP_ALLOW_ORIGINS` allows, when set;
- how many web page tabs are open;
- the Web GUI tabs, with system, client and transaction;
- the Fiori tabs, with SAPUI5 version, system, client and user.

When no Chrome is found, it says the one step to take.

## Limits

- Chrome is supported; Microsoft Edge is found the same way and is likely
  to work; Firefox and Safari are not.
- Web GUI in a background tab is slower (see above).
- Lists scroll down and up, not sideways: a grid wider than the screen
  shows the columns SAP has drawn.
- Web GUI draws only the tree nodes in view; a node further down is reached
  by scrolling the tree first.
- Record and replay have been run on Web GUI; not yet on Fiori
  ([Recording and replay](record-replay.md)).
- Safe and commit words are known in a handful of languages; in others
  more actions are held ([Safety model](../concepts/safety.md)).
