# SAP systems (Chrome extension for sap-gui-mcp-server)

Your SAP systems in one list, in the Chrome you use every day. Register each
system once: its name, its address (Web GUI or the Fiori launchpad), client,
language and, if you like, user and password. Then:

- **you** open any of them in one click, logged on;
- **your agent** (sap-gui-mcp-server with `SAP_BROWSER=extension`) can list
  them and say "log on to ECC dev" without knowing the address, and works in
  their tabs.

The agent never sees a password. The extension types it into SAP's logon
page itself, like a password manager, in a tab the agent cannot see until
the logon page is gone. The server is told only "logged on as JDOE" or SAP's
message.

You keep your normal profile and its single sign-on. You don't turn on
Chrome's remote debugging. Only the tabs of your registered systems are
shared.

It works in Chrome 132 or later, and in Microsoft Edge and other Chromium
browsers.

## Install

The extension is not in the Chrome Web Store yet. Load it unpacked:

1. In a terminal, run:

   ```sh
   npx -y sap-gui-mcp-server extension install
   ```

   It copies the extension to `~/sap-gui-mcp-extension` (or to the folder
   you name after `install`), and installs its **helper**: a small program
   Chrome starts for this extension only. The helper pairs the extension with
   the server in one click and keeps saved passwords in your keychain.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick that folder.
4. Pin the extension's icon, so you can see its status.

To update it, run `install` again, then click the reload arrow on the
extension's card in `chrome://extensions`.

## Pair

Click the icon, then **Pair with this computer**. That's all: the helper
gives the extension the code the server uses. If the extension was loaded
before the helper was installed, restart Chrome once.

Without the helper, pair by hand: run `npx -y sap-gui-mcp-server extension
pair`, open *Pair with a code instead* in the popup and paste the code.

The popup then says **Ready: your agent connects when it needs SAP**. It
turns green, **Connected**, while an agent is working, and names the tab it
is working in.

## Add your systems

Open your SAP system in a tab and click **Add the SAP page I'm on**: the
address, client and language come from the page. Give it a name, add the
user and password if the extension should log on for you, and click
**Save**. Chrome asks once to allow the extension on that site. Or click
**+ Add** and type the address.

- **Single sign-on**: tick *Single sign-on* and leave the password out. The
  extension just opens the address.
- **No password saved**: the extension opens the logon page and you type it.
- **Open** opens the system in a tab, logged on, or switches to its tab.

Then tell the agent what to do in it. With `SAP_BROWSER=extension` the
server has two more tools: `sap_systems` lists your systems, and
`sap_logon` opens one and logs on. Set it in the MCP client's settings:

```json
"env": { "SAP_BROWSER": "extension", "SAP_WRITE": "off" }
```

`npx -y sap-gui-mcp-server doctor` with `SAP_BROWSER=extension` tells you
whether the extension is connected and paired.

## Where your passwords are

- **With the helper**: in your keychain. That is the macOS Keychain (entries
  named "sap-gui-mcp-server: <system>"), the Secret Service on Linux
  (`secret-tool`), or a file protected with Windows DPAPI, which only your
  Windows account can read.
- **Without it** (or with no keychain on the computer): in this Chrome
  profile's local storage, on this computer only. The popup says so when
  you save.
- Never in Chrome sync, never in a log, never sent to the server or the
  agent. Delete a system, and its password is deleted too.

## What it can see and do

- **Permissions.** `debugger` (to drive tabs and to type into the logon
  page), `storage`, `alarms` and `nativeMessaging` (the helper). It asks for
  sites one at a time, when you save a system. You can see and remove them
  under *Site access* in `chrome://extensions`.
- **Which tabs.** Only http and https tabs of your registered systems are
  shared. A tab that navigates to another site is detached when the
  navigation starts, so nothing of that page reaches the server. Frames and
  workers of other sites inside a shared tab are not shared either.
- **What the extension refuses.** Even on a shared tab, it refuses commands
  that reach beyond that tab: opening or closing tabs, the browser's cookie
  jar, cookies, storage and responses of other sites, request interception,
  and navigating the tab to a site you did not register.
- **Other logons.** When SAP says the user is logged on already and asks
  whether to end the other logons, the extension keeps them. It never ends
  your other sessions.
- **How it reaches the server.** The extension connects only to
  `127.0.0.1`, ports 47823–47830, or the one port set under *Settings*.
  Before it acts, the server must prove that it holds the pairing code. After
  that, every message is encrypted and authenticated with keys derived from
  the code. Web pages cannot connect: the server accepts only an extension.
- **The yellow bar.** While the server works in your tabs, Chrome shows
  "SAP systems for sap-gui-mcp-server started debugging this browser".
  Clicking **Cancel** there pauses sharing until you click **Resume sharing**
  in the popup.
- **"Chrome is being controlled by automated test software"** is not this
  extension. Chrome shows that bar when a program started it with
  `--enable-automation` (Playwright, Puppeteer and tools built on them do).
  The popup tells you when that is the case.

## For IT: deploy to a fleet

Managed storage (Chrome policy `3rdparty` → `extensions` → `<id>`) takes:

| Key | Effect |
| --- | --- |
| `allowedOrigins` | match patterns of SAP sites to share, e.g. `https://*.s4hana.example.com/*`. Users cannot remove them |
| `pairingCode` | the code the servers are started with (`SAP_EXTENSION_CODE`), so users don't pair by hand |
| `port` | the one port to use (the servers' `SAP_EXTENSION_PORT`) |

The schema is in `managed_schema.json`. Install the extension itself with
`ExtensionInstallForcelist`. The unpacked extension's id is
`ojokfbbfoignpfeamomeappgfhapehma` (fixed by the `key` in its manifest).

A pairing code has 26 characters; the extension refuses a shorter one. Every
user who can read the policy holds a `pairingCode` you push. On multi-user
hosts (Remote Desktop Services, Citrix), any user of the host could then act
as the server for the other users' browsers: don't push a shared code there,
let each user pair with their own. Patterns that match every host
(`https://*/*`, `<all_urls>`) in `allowedOrigins` are ignored.

## Limits

- **One server at a time.** The extension connects to one server. A second
  server (for example a second agent app) takes the next port and finds no
  extension; close the first server, or click *Reconnect* under *Settings*.
- **Wake-up.** Chrome puts the extension's worker to sleep when it is idle.
  A server that has just started can wait up to 30 seconds until the
  extension wakes and connects. Opening the popup wakes it at once.
- **The agent opens tabs only through `sap_logon`**, for your registered
  systems. `/o` sessions and popup windows of a registered system are
  shared once they open.
- **Two systems on one address** (the same system with two users): the
  extension treats an open tab of that address as logged on for both.
- **Logon pages.** The extension knows SAP's own logon page (Web GUI and the
  launchpad) and its "already logged on" question. A company page in front
  of SAP (SAML, Azure AD, Okta) is not filled: register such a system as
  single sign-on and log on there yourself.
- **Not in the Web Store.** Developer mode shows a warning at each Chrome
  start, and some companies block unpacked extensions by policy.

## How it works

The extension attaches `chrome.debugger` to the shared tabs. It relays the
Chrome DevTools Protocol over one WebSocket to the server's relay, which
gives Playwright a browser endpoint. See [PROTOCOL.md](PROTOCOL.md).
