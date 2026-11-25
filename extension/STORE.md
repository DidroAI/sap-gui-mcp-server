# Chrome Web Store: listing and release notes

What to paste into the developer dashboard, and what to do once per release.
The extension is distributed unpacked until the first store release.

## Listing

- **Name:** UI Automation for SAP
- **Summary (132 characters max):** See what your local AI agent does in SAP, from Chrome's side panel. Passwords stay in your keychain. Not affiliated with SAP SE.
- **Category:** Developer Tools (alternative: Workflow & Planning)
- **Description:**

  > UI Automation for SAP lets an AI agent that runs on your own computer (through the open-source sap-ui-automation) work in your SAP systems in the Chrome you use every day. A side panel beside your SAP tabs shows each step the agent takes, in SAP's own words, and when it waits for your yes to save.
  >
  > Register each SAP system once (Web GUI or Fiori launchpad address, client, language, user). Your agent can then list them, open one and log on, and work in its tabs: with your SAP authorizations, and only in the systems you registered.
  >
  > The agent never sees your password: the extension types it into SAP's logon page itself, in a tab the agent cannot see, and keeps it in your operating system's keychain. Nothing leaves your computer: the extension talks only to the local server on 127.0.0.1 and to your SAP systems.
  >
  > Requires the free helper and server: `npx -y sap-ui-automation extension helper` (Node.js 22 or later).
  >
  > Not affiliated with or endorsed by SAP SE. SAP, SAP Fiori and SAP S/4HANA are trademarks of SAP SE.

- **Privacy policy URL:** https://github.com/DidroAI/sap-ui-automation/blob/main/extension/PRIVACY.md
- **Homepage / support:** https://github.com/DidroAI/sap-ui-automation (issues for support)

## Single purpose

"Let a local AI agent open, log on to and operate the SAP systems the user
registered, in the user's own Chrome." Saving logons is part of that purpose:
it is how the agent opens a system without ever holding the password.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `debugger` | Attaches only to tabs of the SAP systems the user registered (and granted site access to), to let the user's local automation server (127.0.0.1, paired with a one-time code) read and operate SAP's screens through the DevTools Protocol, and to type the user's saved SAP password into SAP's logon page. It never attaches to other tabs, and refuses commands that reach other sites, cookies or the browser. |
| `nativeMessaging` | Talks to the extension's own helper (installed by the user with npm) to read the local pairing code and to keep SAP passwords in the operating system's keychain instead of the browser. |
| `storage` | Keeps the user's list of SAP systems and settings in `chrome.storage.local` (never sync). |
| `alarms` | Wakes the service worker every 30 seconds to reconnect to the local server when the user's agent starts. |
| Optional host permissions `http://*/*`, `https://*/*` | Requested one site at a time, at the moment the user saves an SAP system, for that system's host only. Never requested for all sites; patterns matching every host are ignored. |

Remote code: none. Every script is in the package; the scripts the extension
runs in SAP pages through `chrome.debugger` are part of it (`background.js`).
It also relays DevTools Protocol commands from the user's own local
automation server (127.0.0.1, paired with a one-time code), which is the
`debugger` API's documented purpose. Those commands are limited by the
extension, not trusted: only to tabs of the systems the user registered,
never to other targets or the browser, with a deny-list for cookies,
storage and responses of other sites, request interception and
navigation elsewhere, and never to a tab that shows a password field. The
rules and their tests are listed in `PROTOCOL.md` ("Scope", "Pages with a
password field are never shared"). Other DevTools-bridge extensions for
local automation (such as Playwright's MCP bridge) follow the same model.

## Data use form

- Collects: **Authentication information** (SAP passwords, kept in the OS
  keychain on the device), **Website content** (pages of registered SAP
  systems, passed to the local server only).
- Certify: not sold; not used or transferred for purposes unrelated to the
  single purpose; not used for creditworthiness or lending.

## Assets

- Icon: `icons/128.png` (96 px artwork in 16 px of clear space; flat tile,
  no SAP artwork). Smaller sizes are drawn separately (`icons/mark-16.svg`).
- Screenshots (1280×800): the side panel beside a page (working, asking to
  save, logging on and a rejected password, first run, settings), made against made-up SAP
  pages for each release and placed on a plain background; never SAP's logo
  or a real customer system.
- Small promo tile (440×280): the mark and the name, no SAP blue gradient or
  SAP logo.
- Both are made by `SAP_TEST_CHROME=<chrome> node scripts/extension-screenshots.mjs`
  into `store-assets/` (not committed): the real side panel, fed made-up systems on
  `sap.example.com`.

## The extension id

- The unpacked id is `ojokfbbfoignpfeamomeappgfhapehma`, fixed by `key` in
  `manifest.json`. The native helper allows only the ids in `EXTENSION_IDS`
  (`src/browser/extension/native.ts`).
- First store upload: include the private key (`key.pem`) in the zip's root
  so that the store keeps this id; remove `"key"` from the uploaded
  manifest. The key is held by the maintainers, outside the repository.
  If the store gives another id (or for Edge Add-ons, which always does),
  add it to `EXTENSION_IDS` and release the npm package before the store
  version.

## Building the upload

```sh
npm run pack:extension                      # agent-connector-<version>.zip
npm run pack:extension -- --key key.pem     # first upload only: keeps the id
```

The zip holds what the extension runs, `LICENSE` and `PRIVACY.md`; the
manifest goes without `"key"`. Store users install only the helper:
`npx -y sap-ui-automation extension helper`.

## Versions

The extension has its own version (`manifest.json`), raised with every
upload; the npm package has its own. `minimum_chrome_version` is 132 because
the extension relies on the `Page.frameStartedNavigating` event (Chrome 132)
to detach a tab before it leaves the registered sites.
