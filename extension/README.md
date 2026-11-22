# sap-gui-mcp-server bridge (Chrome extension)

This extension lets sap-gui-mcp-server read and drive SAP Web GUI and Fiori
tabs in the Chrome you use every day. You keep your normal profile and its
single sign-on. You don't turn on Chrome's remote debugging, and you don't
tick the box in `chrome://inspect`. The extension shares only the tabs of
sites you allow.

It works in Chrome 132 or later, and in Microsoft Edge and other Chromium
browsers.

## Install

The extension is not in the Chrome Web Store yet. Load it unpacked:

1. Copy the extension to a folder that stays put:

   ```sh
   npx -y sap-gui-mcp-server extension unpack
   ```

   It goes to `~/sap-gui-mcp-extension`, or to the folder you name after
   `unpack`.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick that folder.
4. Pin the extension's icon, so you can see its status.

To update it, run `unpack` again, then click the reload arrow on the
extension's card in `chrome://extensions`.

## Pair

The server and the extension share a secret code. Neither side obeys the
other until both have proved that they hold it.

1. Run:

   ```sh
   npx -y sap-gui-mcp-server extension pair
   ```

   It prints the code. On first use it creates the code and keeps it in
   `~/.config/sap-gui-mcp-server/extension-pairing`. On macOS the file is in
   `~/Library/Application Support/sap-gui-mcp-server/`, and on Windows in
   `%APPDATA%\sap-gui-mcp-server\`. Only you can read it.
2. Click the extension's icon, paste the code and click **Save**.
3. Open your SAP system and click **Allow this site** in the popup. Chrome
   asks you to confirm.
4. Start the server with `SAP_BROWSER=extension`. For example, in the MCP
   client's settings:

   ```json
   "env": { "SAP_BROWSER": "extension", "SAP_WRITE": "off" }
   ```

`npx -y sap-gui-mcp-server doctor` with `SAP_BROWSER=extension` tells you
whether the extension is connected, paired, and sees your SAP tabs.

## What it can see and do

- **Permissions.** The extension asks for `debugger` (to drive tabs),
  `storage` and `alarms`. It requests sites one at a time, as optional host
  permissions, when you click *Allow this site*. You can see and remove them
  in the popup or under *Site access* in `chrome://extensions`.
- **Which tabs.** Only http and https tabs of allowed sites are shared. A
  tab that navigates to another site is detached when the navigation starts,
  so nothing of that page reaches the server. Frames and workers of other
  sites inside a shared tab are not shared either.
- **"On all sites".** If you set the extension's site access to *On all
  sites* in Chrome, it still shares only the sites you add with *Allow this
  site*. The popup reminds you of this.
- **What the extension refuses.** Even on an allowed tab, it refuses
  commands that reach beyond that tab: opening or closing tabs, the
  browser's cookie jar, cookies, storage and responses of other sites,
  request interception, and navigating the tab to a site you did not allow.
- **How it reaches the server.** The extension connects only to
  `127.0.0.1`, ports 47823–47830, or the one port set under *Advanced*.
  Before it acts, the server must prove that it holds the pairing code: a
  program that took the port first gets nothing. After that, every message
  is encrypted and authenticated with keys derived from the code, so a
  program in the middle can neither read nor inject anything. Web pages
  cannot connect, because the server accepts only an extension origin.
- **What the server does with a tab.** It looks at a shared tab only if it
  is a Web GUI or Fiori page (see the main README). `SAP_ALLOW_ORIGINS` and
  `SAP_WRITE` apply as always.
- **The yellow bar.** While the server works in your tabs, Chrome shows
  "sap-gui-mcp-server bridge started debugging this browser". Clicking
  **Cancel** there pauses sharing for the whole browser, until you click
  **Resume sharing** in the popup. **Pause sharing** in the popup does the
  same.

## For IT: deploy to a fleet

Managed storage (Chrome policy `3rdparty` → `extensions` → `<id>`) takes:

| Key | Effect |
| --- | --- |
| `allowedOrigins` | match patterns of SAP sites to share, e.g. `https://*.s4hana.example.com/*`. Users cannot remove them |
| `pairingCode` | the code the servers are started with (`SAP_EXTENSION_CODE`), so users don't pair by hand |
| `port` | the one port to use (the servers' `SAP_EXTENSION_PORT`) |

The schema is in `managed_schema.json`. Install the extension itself with
`ExtensionInstallForcelist`.

A pairing code has 26 characters; the extension refuses a shorter one. Every
user who can read the policy holds a `pairingCode` you push. On multi-user
hosts (Remote Desktop Services, Citrix), any user of the host could then act
as the server for the other users' browsers: don't push a shared code there,
let each user pair with their own. Patterns that match every host
(`https://*/*`, `<all_urls>`) in `allowedOrigins` are ignored.

## Limits

- **One server at a time.** The extension connects to one server. A second
  server (for example a second agent app) takes the next port and finds no
  extension; close the first server, or click *Reconnect* in the popup.
- **Downloads.** A file that the page downloads goes to Chrome's own
  download folder, as when you work by hand. It is the same with remote
  debugging. Web GUI's "save to local file" also works: the server copies
  that file out of the page into `SAP_DOWNLOAD_DIR`.
- **Wake-up.** Chrome puts the extension's worker to sleep when it is idle.
  A server that has just started can wait up to 30 seconds until the
  extension wakes and connects. Opening the popup wakes it at once.
- **The server cannot open tabs.** Open your SAP system yourself. `/o`
  sessions and popup windows of an allowed site are shared once they open.
- **Not in the Web Store.** Developer mode shows a warning at each Chrome
  start, and some companies block unpacked extensions by policy.

## How it works

The extension attaches `chrome.debugger` to allowed tabs. It relays the
Chrome DevTools Protocol over one WebSocket to the server's relay, which
gives Playwright a browser endpoint. See [PROTOCOL.md](PROTOCOL.md).
