# Security

## Report a vulnerability

Please do not open a public issue. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/DidroAI/sap-ui-automation/security/advisories/new).

Without a GitHub account, email pierre@didro.ai.

Say what you did, what happened, and which version, surface (SAP GUI for
Windows, the `diag` method, Web GUI, Fiori) and MCP client you used. Leave
real SAP data out: made-up values reproduce most problems.

We aim to answer within a week, and to fix a confirmed issue in the latest
version. We will agree a disclosure date with you, and credit you in the
advisory unless you ask us not to.

## Supported versions

| Version | Supported |
| --- | --- |
| latest 0.x release | yes |
| older releases | no: please update first |

Before 1.0, only the latest published version gets fixes.

## What we want to hear about

- an action that writes to SAP while `SAP_WRITE=off`, or without the yes
  that `SAP_WRITE=confirm` asks for;
- a way round `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES`,
  `SAP_ALLOW_ORIGINS` or `SAP_ALLOW_LOGOFF`;
- typing into a password field, acting on a logon screen, or a password
  reaching the agent, a log or a recording;
- the server reading browser tabs that are not SAP tabs;
- the local SAProuter of the `diag` method reachable from another machine;
- with the Chrome extension: a tab of a system you did not register shared
  with the server, the extension's local port answering a web page or an
  unpaired client, or a saved SAP password reaching the server, the agent
  or a log;
- a recording or a tool argument that makes the server read or write a file
  outside its directory;
- any network connection the server makes that this page does not list.

## Data handling

The server runs on your machine, as a process your MCP client starts. It
has no server side, and no account.

- **No telemetry, no analytics, no update checks.** The server opens no
  connection other than the ones listed next.
- **Network connections.** The server connects only to:
  - your SAP front end on this machine: SAP GUI for Windows through SAP GUI
    scripting (a Windows PowerShell process it starts), or Chrome or Edge
    through the DevTools protocol on `127.0.0.1` (the Chrome window it
    starts itself in the default `SAP_BROWSER=launch`, your Chrome's
    endpoint from its `DevToolsActivePort` file with `attach`, or the one
    you name in `SAP_CHROME_CDP`);
  - with `SAP_BROWSER=extension` only: it listens on `127.0.0.1` (the
    first free port of 47823–47830, or `SAP_EXTENSION_PORT`) for the UI
    Automation for SAP extension, which must prove the pairing code before
    it is used;
  - with `SAP_GUI_METHOD=diag` only: it listens on `127.0.0.1` (port 3298,
    or `SAP_DIAG_PORT`) and relays SAP GUI's traffic to the next hop of the
    SAProuter string in your SAP Logon entry, which is your SAP system or
    router.
  It sends nothing to Didro or to any other third party.
- **The only path off your machine is the one you chose.** The server
  answers the MCP client that started it, over stdio. The client sends
  what the server answers (screen content, screenshots) to the model
  provider you configured in it. Choose that provider, and its data
  retention, as you would for any tool that sees your SAP data.
- **The server calls no model.** Replay and the repair of a replay step
  run without one.
- **No credentials.** The server never logs on, never stores a password,
  never types into a password field, and acts on no logon screen. It works
  in sessions you have already opened. With the optional Chrome extension,
  the extension logs on to the systems you registered in it, keeps their
  passwords in your system's keychain through its helper, and types them
  into SAP's logon page itself; the server only learns whether the logon
  worked ([extension/PRIVACY.md](extension/PRIVACY.md)). The exported Playwright spec is the
  one exception, and it is not the server: it is a file you run yourself,
  and it reads `SAP_USER` and `SAP_PASSWORD` from your environment.
- **On disk.** The server writes files only in these cases:

  | What | Where | When |
  | --- | --- | --- |
  | Recordings and exports | `SAP_RECORD_DIR` (default `./sap-tests`) | after `sap_record start`, or with `SAP_RECORD=on` |
  | Files Web GUI exports "to a local file", and browser downloads | `SAP_DOWNLOAD_DIR` (default `downloads` in `SAP_RECORD_DIR` when set, else `./sap-downloads`) | when an action in Web GUI produces such a file |
  | Raw DIAG traffic, logon included | `SAP_DIAG_CAPTURE` | only when set; for debugging |
  | Replay reports, exports from the command line | the paths you pass (`--junit`, `--out`) | when you run the command |
  | MCP client configuration (with a `.bak` copy) | the client's own file | when you run `setup` |

  `./` is the server's working directory, which your MCP client chooses.
  DIAG captures are created readable by their owner only (mode 0600, where
  the file system honours it). Recordings and downloads get your default
  file permissions.
- **Screenshots** from `sap_screenshot` go to the MCP client; the server
  does not save them.

## Threat model

### What we protect

- **SAP data on screen**: everything your SAP user can display.
- **Your SAP session and authorisations**: the agent acts as you, in the
  sessions you have open.
- **Files on disk**: recordings, downloads and captures, which hold
  business data and, for DIAG captures, the logon.

### Who might misuse it

- **The model or agent**, by mistake, or because text on an SAP screen (a
  long text, a note on an order) holds instructions aimed at it: prompt
  injection through screen content.
- **Other programs on the same machine**, which can reach the browser's
  DevTools endpoint and, with the `diag` method, the local SAProuter port.
- **People who get a recording, a download or a capture.**

### Mitigations

- **Each write waits for your yes by default.** Each surface classifies an
  action as read, navigate or commit before it runs, and fails closed:
  anything not known to be safe is a commit. Commits are asked about in
  your MCP client (`SAP_WRITE=confirm`, the default; refused when the
  client cannot ask), refused (`off`: read-only), or allowed (`on`).
- **Where:** allow lists of systems and clients (`SAP_ALLOW_SYSTEMS`), of
  browser origins (`SAP_ALLOW_ORIGINS`), and allow and block lists of
  transactions (`SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES`), checked on every
  call. A session that moves to another system is refused from then on.
- **The command field** takes commands only through the `okcode` action, so
  a command cannot go round the transaction lists.
- **Logging off** (`/nex`, `/nend`, `/i`, Log Off) is refused unless
  `SAP_ALLOW_LOGOFF=on`, also with `SAP_WRITE=on`.
- **Logons:** password fields cannot be typed into, and nothing runs on a
  logon screen.
- **Confirmations** are bound to the session, system, client, transaction,
  window title and action, checked again before the action runs, used once,
  and expire after ten minutes.
- **Chrome:** the server attaches only to a Chrome that announces remote
  debugging in its own profile, or to the endpoint you name. It does not
  try port 9222 on its own. It lists only http and https tabs it recognises
  as SAP, and only `SAP_ALLOW_ORIGINS` when set.
- **The `diag` router** listens on `127.0.0.1` only.
- **Recordings** are read and written in one directory; tools take a name,
  never a path.

### Not protected against (non-goals)

The guard is a safety net for an agent that makes mistakes. It is not a
security boundary against a determined attacker, and it does not replace
SAP's own authorisations.

- **Your SAP authorisations are the real limit.** The agent can do
  everything your user can do once writes are on, and can read everything
  your user can read, with writes off too. Use a test system and a user
  with only the authorisations you want the agent to have.
- **The classification is a heuristic.** It knows buttons, keys, function
  codes and words in a few logon languages. A custom button whose text is
  on the safe list can still write. **Execute (F8)** counts as navigate,
  and a report started with it can update the database. Put such programs
  in `SAP_BLOCK_TCODES`.
- **Confirm mode needs a client that asks you.** With `SAP_WRITE=confirm`
  the server asks you through the MCP client (elicitation); a client that
  cannot ask gets every write refused. Codex in Full Access mode accepts
  the question without showing it: use `off` there. With `SAP_WRITE=on`, the only check
  left is your client's own approval of each `sap_act` call, which you
  configure in the client. The agent CLI asks
  nothing itself.
- **An agent with a shell can widen its own settings.** The settings are
  environment variables: an agent that runs shell commands can start the
  agent CLI with `SAP_WRITE=on` in front of the command. The bundled skills
  forbid it, but only your approval of each command stops it.
- **A write runs only on the screen the agent was last shown.** When SAP
  has moved on, the write does not run and the agent gets the current
  screen; a write that did not run tells the agent to leave the
  transaction without saving, so SAP releases the document's lock.
- **Not tried live yet:** confirm mode on Fiori and SAP GUI for Windows
  (it was tried on Web GUI), and writes through the network reader.
- **What the agent reads leaves the server.** Screen content goes to your
  MCP client and the model behind it. The guard does not stop the agent
  from passing what it read to other tools it has (a web search, a file
  write, another MCP server).
- **Screen content is not trusted input.** The guard still applies to every
  action, but read-only access to data can be misused by an agent that
  follows instructions found on a screen.
- **Remote debugging opens the whole browser.** The server reads only SAP
  tabs, but any program that can reach the browser's DevTools endpoint can
  read every tab. Use a separate Chrome profile for SAP work.
- **The `diag` method** reads SAP GUI traffic in the clear, which is why it
  cannot work with SNC. Any program on the same machine can connect to its
  router and pass traffic to the next hop of a route. `SAP_DIAG_CAPTURE`
  writes that traffic to disk, logon included: use it only to debug, on
  your own machine, and delete the files afterwards.
- **Recordings hold what was typed.** Treat `SAP_RECORD_DIR` and
  `SAP_DOWNLOAD_DIR` like the system's data.
- **The server process runs as you.** On Windows it starts Windows
  PowerShell to reach SAP GUI; `setup` edits your MCP clients'
  configuration files (keeping a `.bak`).
- **Installing it.** `npx -y sap-ui-automation` fetches the package from
  the npm registry when it is not cached. That is npm, not the server. Pin
  a version in your client configuration if you want the same code every
  time.
