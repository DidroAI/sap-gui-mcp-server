# Extension ⇄ server protocol

The extension (`extension/`, MV3) and sap-gui-mcp-server talk over one
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
server keeps it in a file (`pairing.ts`: `~/.config/sap-gui-mcp-server/extension-pairing`
on Linux, `~/Library/Application Support/sap-gui-mcp-server/…` on macOS,
`%APPDATA%\sap-gui-mcp-server\…` on Windows; mode 0600), created on first use;
`SAP_EXTENSION_CODE` overrides it (tests, CI). `sap-gui-mcp-server extension pair`
prints it; the user pastes it into the extension popup once.

Normalized code = uppercase, every character outside `[0-9A-Z]` removed, and
Crockford's look-alikes mapped (`I`,`L` → `1`, `O` → `0`). The HMAC key is the
UTF-8 bytes of the normalized code.

Handshake (JSON text frames), mutual, the code itself never crosses the wire:

1. Relay → ext: `{"type":"hello","v":1,"nonce":"<b64 16 bytes>","server":"sap-gui-mcp-server","version":"0.1.0"}`
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
the managed `pairingCode` and the popup refuse anything else): a fake relay
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
`{"id":N,"result":{...}}` or `{"id":N,"error":{"message":"...","code":-32000}}`.

| Relay → ext | Result |
|---|---|
| `{"id","type":"tabs"}` | `{"tabs":[Tab...]}`: allowed tabs only (see Scope), attached or not |
| `{"id","type":"attach","tabId"}` | `{"tab":Tab}` after `chrome.debugger.attach({tabId},"1.3")` (already attached: same answer) |
| `{"id","type":"detach","tabId"}` | `{}` |
| `{"id","type":"cdp","tabId","sessionId"?,"method","params"?}` | `{"result":{...}}` = `chrome.debugger.sendCommand({tabId, sessionId}, method, params)`; CDP errors come back as `error` with the CDP code and message |

`Tab` = `{"tabId":123,"targetId":"<CDP target id>","url":"...","title":"...","openerTabId"?:122}`.

Messages from the extension without `id`:

| Ext → relay | When |
|---|---|
| `{"type":"event","tabId","sessionId"?,"method","params"}` | `chrome.debugger.onEvent`; `sessionId` = `source.sessionId` (a child session: OOPIF, worker), absent for the tab's own session |
| `{"type":"tabAdded","tab":Tab}` | a tab became allowed: opened, navigated into an allowed origin, origin granted, sharing resumed |
| `{"type":"tabRemoved","tabId","reason":"closed"\|"left_origin"\|"origin_revoked"\|"paused"}` | a tab is no longer allowed; the extension has already detached it |
| `{"type":"detached","tabId","reason"}` | `chrome.debugger.onDetach` (`target_closed`, `canceled_by_user`) |
| `{"type":"ping"}` | every 20 s (keeps the MV3 service worker alive); relay answers `{"type":"pong"}` |

## Scope (enforced by the extension)

A tab is allowed when all hold:
- its URL is http(s) and matches one of: the host permissions the user granted
  (`chrome.permissions.getAll().origins`, from the popup's "Allow this site"),
  or `allowedOrigins` in managed storage (IT policy, match patterns);
- sharing is not paused. Clicking Cancel on Chrome's "started debugging this
  browser" bar (`onDetach` reason `canceled_by_user`) pauses sharing for the
  whole browser until the user clicks Resume in the popup.

An attached tab that navigates outside the allowed origins is detached at
once, when the navigation starts (`tabRemoved` `left_origin`), so nothing of
that page reaches the relay. A navigation that never happens (a download, a
204) brings the tab back with `tabAdded`. Closing an attached tab sends both
`detached` (`target_closed`) and `tabRemoved` (`closed`): the relay handles
either, once.

Bare wildcard host patterns (`<all_urls>`, `https://*/*`, Chrome's "On all
sites") are ignored, from grants and policy: then only the sites added with
"Allow this site" (kept by the extension, and still covered by Chrome's
grant) are shared.

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
