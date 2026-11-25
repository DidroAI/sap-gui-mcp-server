# Extension ⇄ server protocol

The extension (`extension/`, MV3) and sap-ui-automation talk over one
WebSocket on 127.0.0.1. The server side is `src/browser/extension/`. This file
is the contract both sides implement; change both together.

## Roles

- **Relay** (in the server process): listens on `127.0.0.1`, first free port of
  47823–47830 (`SAP_EXTENSION_PORT` names one port instead). Two endpoints:
  - `ws://127.0.0.1:<port>/extension`: the extension connects here. Requests
    must carry an `Origin: chrome-extension://…` header (a web page cannot
    connect), and must pass the pairing handshake below. One extension at a
    time: a second authenticated extension is refused with reason `busy`.
  - `ws://127.0.0.1:<port>/cdp/<secret>`: a Chrome DevTools Protocol browser
    endpoint for Playwright's `connectOverCDP`. `<secret>` is 32 random hex
    bytes made at relay start and never written anywhere: only this process
    knows it. Requests with an `Origin` header are refused. One CDP client at a
    time.
  - Any other path or plain HTTP: 404. `GET /json/version` is NOT served.
- **Extension** (service worker `background.js`): scans the port range (or the
  one port set in its options), connects, authenticates, then executes the
  relay's requests with `chrome.debugger` on allowed tabs only.

## Pairing

A pairing code is 26 Crockford base32 characters (130 random bits), shown as
`ABCDE-FGHJK-MNPQR-STVWX-YZ012-3` style groups (dashes are cosmetic). The
server keeps it in a file (`pairing.ts`: `~/.config/sap-ui-automation/extension-pairing`
on Linux, `~/Library/Application Support/sap-ui-automation/…` on macOS,
`%APPDATA%\sap-ui-automation\…` on Windows; mode 0600), created on first use;
`SAP_EXTENSION_CODE` overrides it (tests, CI). `sap-ui-automation extension pair`
prints it; the user pastes it into the extension's side panel once.

Normalized code = uppercase, every character outside `[0-9A-Z]` removed, and
Crockford's look-alikes mapped (`I`,`L` → `1`, `O` → `0`). The HMAC key is the
UTF-8 bytes of the normalized code.

Handshake (JSON text frames), mutual, the code itself never crosses the wire:

1. Relay → ext: `{"type":"hello","v":1,"nonce":"<b64 16 bytes>","server":"sap-ui-automation","version":"0.1.0"}`
2. Ext → relay: `{"type":"auth","nonce":"<b64 16 bytes>","mac":"<b64 HMAC-SHA256(key, 'sap-gui-ext|' + nS + '|' + nE)>","extensionVersion":"0.1.0","userAgent":"<navigator.userAgent>"}`
3. Relay → ext, mac good: `{"type":"welcome","mac":"<b64 HMAC-SHA256(key, 'sap-gui-srv|' + nS + '|' + nE)>"}`.
   The extension checks this mac before it executes anything; a bad mac closes
   the socket (a process squatting on the port does not hold the code).
   Mac bad: `{"type":"refused","reason":"code"}`, close code 4001. Busy:
   `{"type":"refused","reason":"busy"}`, close 4002. Compare macs in constant time.
4. No `auth` within 10 s: the relay closes (4000).
5. Before the handshake the relay closes a socket that sends a frame over
   4 KiB (1009), and keeps at most 4 unauthenticated sockets open at once.

A code is 26 characters after normalizing, on both sides (`SAP_EXTENSION_CODE`,
the managed `pairingCode` and the side panel refuse anything else): a fake relay
collects MACs over nonces it chooses, so a short code could be brute-forced
offline.

## Every frame after `welcome` is encrypted

The handshake proves both ends hold the code, but a process in the middle
(another user on a shared Windows/Citrix host who took a port first) could
pass the handshake through and then read and inject plain frames. So after
`welcome`, nothing travels in clear:

- Keys (32 bytes each): `kS2E = HMAC-SHA256(key, "sap-gui-key-s2e|" + nS + "|" + nE)`
  for relay → extension, `kE2S = HMAC-SHA256(key, "sap-gui-key-e2s|" + nS + "|" + nE)`
  for extension → relay. `key` is the pairing key above.
- Each message is one **binary** WebSocket frame: AES-256-GCM of the UTF-8 JSON,
  no additional data, IV = 4 zero bytes + an 8-byte big-endian counter. Each
  direction has its own counter, starting at 0 and +1 per frame. Frame bytes =
  ciphertext followed by the 16-byte tag (what WebCrypto's `encrypt` returns).
- The receiver uses its own counter for the IV: a frame dropped, replayed,
  reordered or forged fails to decrypt. A failed decrypt, or a text frame after
  `welcome`, closes the socket (4003).
- `welcome` is the last frame in clear. The relay may send encrypted frames
  right after it; the extension decrypts them in order once its keys are ready.

`nS`, `nE` are the base64 strings exactly as sent.

## After the handshake

Requests from the relay carry an integer `id`; the extension answers each with
`{"id":N,"result":{...}}` or `{"id":N,"error":{"message":"...","code":-32000,"reason"?:"..."}}`.

| Relay → ext | Result |
|---|---|
| `{"id","type":"tabs"}` | `{"tabs":[Tab...]}`: allowed tabs only (see Scope), attached or not |
| `{"id","type":"attach","tabId"}` | `{"tab":Tab}` after `chrome.debugger.attach({tabId},"1.3")` (already attached: same answer) |
| `{"id","type":"detach","tabId"}` | `{}` |
| `{"id","type":"cdp","tabId","sessionId"?,"method","params"?}` | `{"result":{...}}` = `chrome.debugger.sendCommand({tabId, sessionId}, method, params)`; CDP errors come back as `error` with the CDP code and message |
| `{"id","type":"systems"}` | `{"systems":[System...]}`: the registered SAP systems (see Systems) |
| `{"id","type":"logon","system","otherLogons"?}` | `{"system","client","user","state","tabId","targetId","reason"?,"message"?}` (see Systems and logging on); a refusal comes back as `error` with a `reason` |

`Tab` = `{"tabId":123,"targetId":"<CDP target id>","url":"...","title":"...","openerTabId"?:122}`.

Messages from the extension without `id`:

| Ext → relay | When |
|---|---|
| `{"type":"event","tabId","sessionId"?,"method","params"}` | `chrome.debugger.onEvent`; `sessionId` = `source.sessionId` (a child session: OOPIF, worker), absent for the tab's own session |
| `{"type":"tabAdded","tab":Tab}` | a tab became allowed: opened, navigated into an allowed origin, origin granted, sharing resumed |
| `{"type":"tabRemoved","tabId","reason":"closed"\|"left_origin"\|"origin_revoked"\|"paused"\|"logon"}` | a tab is no longer allowed; the extension has already detached it |
| `{"type":"detached","tabId","reason"}` | `chrome.debugger.onDetach` (`target_closed`, `canceled_by_user`) |
| `{"type":"ping"}` | every 20 s (keeps the MV3 service worker alive); relay answers `{"type":"pong"}` |

Notes from the relay without `id`, for the side panel (no answer; an older
extension ignores them):

| Relay → ext | When |
|---|---|
| `{"type":"panel","agent","policy":{"write","systems","transactions","blocked","logoff"}}` | after `welcome`, and when the agent's client says its name: who the agent is ("Codex") and what `SAP_WRITE`, `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES` and `SAP_ALLOW_LOGOFF` allow. Never a secret |
| `{"type":"activity","state","do","label","value","transaction","title","system","client","agent","at"}` | a step of the agent: `ran`, `waiting` (for the user's yes), `refused` or `declined`; `label` is the control's label on the screen the agent saw, `value` what it typed (at most 80 characters). The extension keeps the last 80 in `chrome.storage.session` |

## Systems and logging on

The user registers SAP systems in the side panel. A system is
`{"id","name","url","kind":"webgui"|"fiori"|"other","client","language","user","logon":"password"|"sso"|"manual","open","issue"?}`
as the relay sees it; its password is never part of it. `issue` is SAP's last
answer while it stands: `{"reason":"wrong_password"|"user_locked","at"}`.
The host of every registered system is a shared site (`<scheme>://<host>/*`,
any port), and those sites are the only tabs the server ever sees: the
registered systems are the allowed origins. `SAP_ALLOW_ORIGINS` is not
needed with the extension; when it is set anyway it narrows what the server
looks at further, and `sap_systems` and `sap_logon` say when it leaves a
registered system out.

### Who starts what

```
 agent            MCP server (sap_logon)       relay (in the server)        extension (service worker)          Chrome tab           SAP
   |  sap_logon ECC Dev  |                          |                               |                               |                  |
   |-------------------->|  extension connected?    |                               |                               |                  |
   |                     |-- no: Chrome running? ---|  (macOS, Windows: start it,   |                               |                  |
   |                     |   and wait up to 35 s)   |   SAP_EXTENSION_START_CHROME) |                               |                  |
   |                     |                          |<== the extension dials in =====|  (every 30 s, at Chrome start, |                  |
   |                     |                          |    pairing handshake, then     |   or when the panel opens)     |                  |
   |                     |                          |    encrypted frames            |                               |                  |
   |                     |-- logon {system,          ->|-- {"type":"logon"} ---------->|  paused? registered?          |                  |
   |                     |   otherLogons?}           |                               |  a tab of it, logged on, same |                  |
   |                     |                          |                               |  client and user? -> "already" |                  |
   |                     |                          |                               |  SAP refused this password    |                  |
   |                     |                          |                               |  before? -> refuse, type none |                  |
   |                     |                          |                               |-- private tab (about:blank or |                  |
   |                     |                          |                               |   the tab at SAP's logon page)->|                 |
   |                     |                          |  (tab withdrawn: tabRemoved   |-- own chrome.debugger, navigate to url ---------->|
   |                     |                          |   "logon"; no event passes)    |   ?sap-client&sap-language     |<- logon page ----|
   |                     |                          |                               |-- type client, language, user, password; submit once ->|
   |                     |                          |                               |<--------------- Easy Access / launchpad, or SAP's answer |
   |                     |                          |                               |-- empty every password field, detach,           |
   |                     |                          |<- tabAdded (shared again) ----|   bring the tab to the front  |                  |
   |                     |<- {state, user, client,  -|<- result or error {reason} ---|                               |                  |
   |                     |    targetId} | error      |                               |                               |                  |
   |                     |-- finds the tab's session (chrome:<targetId>), makes it the active one                   |                  |
   |<-- "Logged on to ECC Dev as JDOE, client 800" + sessions, or what to ask the user                                |                  |
   |  sap_look / sap_act on that session (the server drives the tab through the relay's CDP endpoint)                  |                  |
```

The server never opens, closes or navigates a tab to log on: the extension
does, and the server only drives the tab once it is shared again. The
password goes from the keychain (through the helper) to `Input.insertText`
in that private tab, and nowhere else: not to the relay, the server, the
agent, a log, or a test fixture.

### When the way is not there

What `sap_logon` (and `sap_systems`) answer, each with the step the agent
asks the user to take:

| Situation | Answer |
|---|---|
| Chrome is not running | macOS and Windows: the server starts the user's own Chrome (`open -a "Google Chrome"`, `start chrome`; no debugging switch, their profile) and waits for the extension. Otherwise, or if it still does not connect: "Google Chrome is not running … ask the user to open Chrome". |
| Chrome runs, no extension dials in | "not installed, switched off in chrome://extensions, or in another Chrome profile", with the install and pair steps. |
| The extension dials in with another code | "Ask the user to click the extension's icon and Pair Again". |
| Another server holds the extension | "Another sap-ui-automation is connected … ask the user to close the other agent". |
| Sharing is stopped (Cancel on Chrome's bar) | error `paused`: "ask the user to click Share again in the extension's side panel". |
| The system is not registered | error `not_registered`, with the registered names: "ask the user to open it in Chrome and click Add This SAP Page. Never ask the user for a password." |

### `logon` request and its answers

`{"id","type":"logon","system":"<name or id>","otherLogons"?:"keep"}`. The
name is matched without case, or by a unique prefix.

Success: `{"system","client","user","state","tabId","targetId","reason"?,"message"?}`:

| `state` | Meaning |
|---|---|
| `logged_on` | The extension typed the saved password and SAP showed Easy Access or the launchpad. |
| `already` | A tab of the system shows SAP logged on (same client and user, where the page tells them: the launchpad's user and client, the address's `sap-client`). It is brought to the front; nothing is typed. This is the "reuse an open tab" rule: a tab at SAP's logon page is not reused for typing (see The logon tab). |
| `sso` | A single sign-on system showed SAP by itself. |
| `needs_user` | The user has to act in the tab, which is in front: `reason` `no_password` (no password saved), `sso_logon_page` (single sign-on, but SAP shows its logon page), `identity_provider` (another host asks the user to sign in). `message` says it to the agent. |

Refusals come back as `error` with a `reason`, and a `message` that tells the
agent what to ask the user (never for the password):

| `reason` | When | The extension |
|---|---|---|
| `wrong_password` | SAP's logon page answers "name or password is not correct" | types nothing for this system again (by the server or the side panel) until the user saves a new password: no lockout from retries |
| `user_locked` | "user is locked", "too many failed attempts" | the server does not retry until the user clicks Log on in the side panel |
| `password_change` | SAP asks for a new password | leaves the tab at SAP's form, in front |
| `multiple_logon` | SAP asks whether to end the user's other logons | leaves the question in the tab. With `otherLogons: "keep"` (after the user said so) it answers "continue without ending"; it never ends other logons |
| `identity_provider` | a password system goes to another host's sign-in page | types nothing there |
| `sap_error` | SAP answers with its error page (e.g. "Log on with a dialog user") | passes SAP's text on |
| `page_changed` | the logon page has no user or password field it knows | the user logs on in the tab |
| `timeout` | nothing SAP-like within 60 s | the tab stays open |
| `refused` | any other message on SAP's logon page | passes it on |
| `paused`, `not_registered`, `password_unreadable` | before anything is opened | |

A refusal that repeats an answer SAP gave earlier (a refused password, a
lock) opened and typed nothing. The side panel shows the standing answer in
the system's row, with the one action that helps (Update Password).

Each attempt submits SAP's form once. SAP's messages are read only from its
error elements (`.lsMessageBar--typeError`, `#LOGIN_ERROR_BLOCK`,
`[role=alert]`…), never its warnings: Web GUI warns about plain HTTP on every
logon page.

### The logon tab

1. Only a tab of SAP logged on (same client and user) is reused, as it is:
   nothing is typed. Every logon that types runs in a **new tab**, opened by
   the extension as `about:blank` with no opener and made private before it
   navigates: nothing is ever typed into a tab the server had, since a
   script the server ran in a page (or a window it opened on the same
   origin) could read the field. The one exception is SAP's question about
   other logons, answered in its own tab with a click, never a key.
2. The extension attaches its own `chrome.debugger` session, turns on
   `Network.setBypassServiceWorker` (a service worker a shared page
   registered on the origin never serves the logon page), navigates to the
   system's address with `sap-client` and `sap-language`, and waits for
   SAP's logon page on the system's own host.
3. Its scripts run in an **isolated world** (`Page.createIsolatedWorld`):
   they see the page's document, not its scripts, which therefore cannot
   patch `focus()` or `querySelector()`. The script that focuses a field
   checks that the page is the system's own host (and https, when the
   system's address is) and the top frame, and that the field has the focus; only then does `Input.insertText` type
   client, user and password. The language is set in SAP's list or field.
4. The form is submitted once. Whatever SAP answers, every password field
   is emptied, and a `pagehide` handler empties them if the page is left
   (the back/forward cache keeps no password). SAP's message is passed on
   with any occurrence of the password replaced, and cut to 200 characters.
5. Logged on or not, the tab is brought to the front: the user sees what
   SAP said.

### Pages with a password field are never shared

A tab that shows a password field (SAP's logon page, its new-password form,
an identity provider's sign-in page) is never shared with the server: the
user may type a password there.

- **Tabs the extension opened for a logon** (and so never shared) stay
  where they are, held back (`tabRemoved` reason `logon`): the extension
  watches them with its own debugger, with service workers bypassed, and
  shares them once the field is gone. `needs_user`, `wrong_password`,
  `password_change` and `identity_provider` leave such a tab with the user.
- **A tab the server had** that loads such a page (SAP's logon page after a
  session timeout), or that shows one when the server first attaches: a
  script the server left in it, or a window of the same origin that holds a
  reference to it, could read what the user types. So the user does not type
  there: the tab is emptied (`about:blank`) and closed, and the same address
  opens in a new tab, held back as above. `attach` answers with an error
  saying so.
- The extension's own attachment and the server's never mix: an `attach`
  that completes after its tab was held back is undone, `cdp` requests and
  events of a held tab are dropped, and held tabs are restored from
  `chrome.storage.session` before a restarted worker answers the relay.

**Limits.** The extension finds a password field by looking at the page; it
cannot stop a page whose scripts the server controls from drawing a
password field of its own (inside a frame, hidden at first, or a fake
"session expired" form), and the server runs scripts in shared SAP pages by
design. The firm guarantee is for passwords the *extension* types: always in
a tab the server never had. A user who types a password should do so in a
tab the extension opened (Log on or Open in the side panel, or the tab
`sap_logon` brought to the front).

### Request bodies

`Network.enable` is always sent with `maxPostDataSize: 65536`, so that the
extension sees a request's body inline. A request whose body names a
password field (form or JSON), and any request whose body Chrome left out,
is forwarded without its body, and `Network.getRequestPostData` for it is
refused. Web GUI's own JSON posts pass as they are.

Only the user adds systems and passwords, in the side panel. The relay has no
request that adds, reads or changes a password or a system.

The password comes from the OS keychain through the helper, or from
`chrome.storage.local` when there is none. It is never written to sync
storage, a log, or the relay.

## The helper (native messaging host)

`sap-ui-automation extension install` installs `ai.didro.sap_ui_automation`
(`native-host/host.mjs`, plain Node.js), allowed for this extension's id
only (fixed by the manifest's `key`). One JSON message per call:

| Ext → helper | Answer |
| --- | --- |
| `{"cmd":"hello"}` | `{"ok":true,"version":1,"keychain":name\|null}` |
| `{"cmd":"pair"}` | `{"ok":true,"code"}`: the machine's pairing code (the file the server reads), made if missing |
| `{"cmd":"secret.set","id","value","label"}` | `{"ok":true,"keychain"}` after a read-back; the password goes to the keychain tool on stdin, never on its command line |
| `{"cmd":"secret.get","id"}` | `{"ok":true,"value"}` |
| `{"cmd":"secret.delete","id"}` | `{"ok":true}` |

Keychains: macOS Keychain (`security`), the Secret Service (`secret-tool`)
on Linux, DPAPI on Windows. The extension pairs through the helper when it
has no code, and again when the relay refuses its code. The helper never
talks to the server.

## Scope (enforced by the extension)

A tab is allowed when all hold:
- its URL is http(s) and matches one of: the host of a system the user
  registered (Chrome granted it when the system was saved, and still does),
  or `allowedOrigins` in managed storage (IT policy, match patterns);
- the extension is not logging on in it (see Systems);
- sharing is not paused. Clicking Cancel on Chrome's "started debugging this
  browser" bar (`onDetach` reason `canceled_by_user`) pauses sharing for the
  whole browser until the user clicks Share again in the side panel.

An attached tab that navigates outside the allowed origins is detached at
once, when the navigation starts (`tabRemoved` `left_origin`), so nothing of
that page reaches the relay. A navigation that never happens (a download, a
204) brings the tab back with `tabAdded`. Closing an attached tab sends both
`detached` (`target_closed`) and `tabRemoved` (`closed`): the relay handles
either, once.

Bare wildcard host patterns (`<all_urls>`, `https://*/*`, Chrome's "On all
sites") are ignored, from grants and policy: then only the hosts of the
registered systems (still covered by Chrome's grant) are shared. Sites added
with "Allow this site" by version 0.1 become systems named by their host.

The extension never attaches anything else and refuses `attach`/`cdp` for a
tab that is not allowed (error). Whatever `chrome.debugger` allows, it also
refuses what would reach beyond the shared sites:

- **At command time** it checks the tab's current URL (`chrome.debugger.getTargets()`,
  cached ≤150 ms) and refuses `Page.disable`, `Network.disable`, and
  `Page.navigate`/`navigateToHistoryEntry` to a URL that is not allowed. It
  enables `Page` on the tab itself, so it always sees a navigation start.
- **Other targets:** `Target.createTarget`, `closeTarget`, `attachToTarget`,
  `attachToBrowserTarget`, `setDiscoverTargets`, `getTargets`,
  `sendMessageToTarget`, `autoAttachRelated`, browser contexts, `Browser.*`.
  `Target.setAutoAttach` only with `flatten: true`.
- **Child sessions** (OOPIFs, workers) are forwarded only when their URL is
  allowed (an iframe with no URL yet is judged by the navigation its frame
  started). A refused child is resumed and detached; its events are dropped and
  commands on it refused. A child that navigates away is detached with a
  synthetic `Target.detachedFromTarget` on the parent's session.
- **Cookies and storage:** `Network.getAllCookies`, `clearBrowserCookies`,
  `Page.getCookies`, `CacheStorage.*`, most `Storage.*`; `Network.getCookies`
  must name `urls`, all allowed; set/delete cookie, `DOMStorage.*`,
  `IndexedDB.*` only for allowed origins.
- **Network reads:** the whole `Fetch.*` domain, `Network.loadNetworkResource`,
  request interception, `IO.read`, `replayXHR`. Response bodies, post data and
  resource content only for requests whose URL is allowed; `Network.*` events of
  other requests are dropped, and a request redirected to a non-allowed site
  gets a synthetic `Network.loadingFailed` (`net::ERR_BLOCKED_BY_CLIENT`).
  Playwright features built on these (`route()`, `httpCredentials`, PDF/trace
  streams) do not work through the extension; the server uses none of them.

Known gap: a frame of another origin of the same site (e.g.
`other.sap.example.com` inside `sap.example.com`) runs in the tab's own
process, so the tab session can reach it.

## CDP emulation (enforced by the relay)

`chrome.debugger` gives one root session per tab, plus flat child sessions.
Playwright expects a browser target. The relay answers browser-level commands
itself and maps sessions:

- `Browser.getVersion` → `{protocolVersion:"1.3", product:"Chrome/<ver from the extension's userAgent>", revision:"", userAgent, jsVersion:""}`.
- `Browser.setDownloadBehavior` → `{}`. Playwright's `connectOverCDP` with `noDefaults` never sends it, so a
  file the page downloads goes to the user's own download folder, as without the server (the same as with
  remote debugging).
- `Browser.getWindowForTarget`, `Browser.setWindowBounds`… → error "not available through the extension".
- `Target.setAutoAttach` on the browser session → attaches every allowed tab,
  emits `Target.attachedToTarget {sessionId:"tab-<tabId>", targetInfo:{targetId, type:"page", title, url, attached:true, canAccessOpener:false, openerId?, browserContextId:"sap-extension"}, waitingForDebugger:false}`
  for each, then answers `{}`. Later `tabAdded` → attach + `attachedToTarget`.
  `tabRemoved`/`detached` → `Target.detachedFromTarget {sessionId, targetId}`.
- `Target.setDiscoverTargets`, `Target.getBrowserContexts` (`{browserContextIds:[]}`), `Target.getTargets`, `Target.getTargetInfo` without target (browser info) → answered locally.
- `Target.attachToBrowserTarget` → a new browser-level session id `browser-<n>`; commands on it are treated like the browser session, except `Target.setAutoAttach`, which answers `{}` without announcing tabs again.
- `Target.attachToTarget {targetId, flatten:true}` → a new alias session `tab-<tabId>-<n>` on the same tab (commands go to the tab's root session; it receives no events). `Target.detachFromTarget {sessionId}` of an alias → drop it, emit `detachedFromTarget` on the session it was attached through (Playwright's `CDPSession.detach()` waits for it there).
- `Target.createTarget`, `Target.closeTarget`, `Target.createBrowserContext`, `Browser.close` → error: the server never opens or closes the user's tabs.
- Commands with `sessionId: "tab-<tabId>"` → `cdp` to that tab. Commands with
  a real child session id (learned from `Target.attachedToTarget` events
  coming from a tab) → `cdp` with that `sessionId` to its tab.
- Events from a tab → re-emitted with `sessionId:"tab-<tabId>"`, or the child session id.
- Answers keep the client's `id` and `sessionId`.
- Extension gone → the CDP client is closed (Playwright sees a disconnect).
- CDP client gone → the relay detaches every tab (the yellow bar goes away).
