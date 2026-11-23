# Privacy policy: Agent Connector for SAP Systems

*Last updated: 23 November 2026*

Agent Connector for SAP Systems ("the extension") is the Chrome extension of
sap-gui-mcp-server, an open-source program by Didro. It lets an AI agent that
runs on your own computer open and work in the SAP systems you register.

## What it handles, and where it stays

| Data | Where it is kept | Who gets it |
| --- | --- | --- |
| The SAP systems you register: name, address, client, language, user | `chrome.storage.local` of your Chrome profile, on this computer | The sap-gui-mcp-server process on this computer (127.0.0.1), which your agent uses |
| SAP passwords you save | Your operating system's keychain, through the extension's helper (macOS Keychain, the Secret Service on Linux, Windows DPAPI) | SAP's logon page only: the extension types it there. Never the server, the agent, Chrome sync or a log |
| The content of the shared tabs (pages of your registered SAP systems) | Not stored by the extension | The sap-gui-mcp-server process on this computer, over an encrypted local connection, while you have not paused sharing |
| The pairing code | `chrome.storage.local` and a file readable only by you | The extension and the server on this computer |
| SAP's answer to the last logon (e.g. "password is not correct", at most 300 characters, never the password) | With the system in `chrome.storage.local`, until the next good logon or until you edit the system | Shown in the popup; the server is told only its kind (`wrong_password`, `user_locked`) |
| Passwords saved by version 0.2 without the helper | `chrome.storage.local`, in clear | Moved to the keychain and deleted from Chrome as soon as the helper is installed |
| Which tabs are shared or held back (tab ids) | `chrome.storage.session` (gone when Chrome closes) | Nobody |
| Chrome's version (user agent) and the extension's version | Not stored | The server on this computer, when it connects |
| For each system: whether a tab of it is open, and the kind of SAP's last answer | Not stored | The server on this computer (`sap_systems`) |

The extension sends nothing to Didro or any other third party. It has no
analytics, no telemetry, no advertising and no remote code. Its only network
connections are to `127.0.0.1` (the local server) and, through your tabs, to
the SAP systems you registered.

What your agent then does with SAP data is between you and the agent you
chose (for example, a cloud AI model reading the screens it works in): see
that agent's own privacy terms. The extension only lets it reach the tabs of
your registered systems, and never a password.

## Limited use

The use of information received from Chrome APIs adheres to the Chrome Web
Store User Data Policy, including the Limited Use requirements. Data is used
only to provide the extension's single purpose (letting your local agent open,
log on to and work in your registered SAP systems), is not sold, not
transferred to third parties, not used for advertising, credit or lending, and
not read by humans.

## Your control

- Remove a system in the popup and its saved password is deleted.
- **Pause Sharing** stops all access by the agent at once.
- `npx -y sap-gui-mcp-server extension uninstall` deletes the helper and every
  password the extension saved; then remove the extension in
  `chrome://extensions`. The pairing code stays, for the server; delete the
  `sap-gui-mcp-server` settings folder too if you remove the server.

## Contact

Questions: open an issue at https://github.com/DidroAI/sap-gui-mcp-server/issues.
