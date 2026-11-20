# Security

## Report a vulnerability

Please do not open a public issue. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/DidroAI/sap-gui-mcp-server/security/advisories/new).

Say what you did, what happened, and which version, surface (SAP GUI for
Windows, the `diag` method, Web GUI, Fiori) and MCP client you used. Leave
real SAP data out: made-up values reproduce most problems.

We aim to answer within a week, and to fix a confirmed issue in the latest
version. Only the latest published version is supported.

Examples of what we want to hear about:

- an action that writes to SAP while `SAP_WRITE=off`, or without the yes
  that `SAP_WRITE=confirm` asks for;
- a way round `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES` or
  `SAP_ALLOW_ORIGINS`;
- typing into a password field, acting on a logon screen, or a password
  reaching the agent, a log or a recording;
- the server reading browser tabs that are not SAP tabs;
- the local SAProuter of the `diag` method reachable from another machine.

## What the server does

The server works in SAP sessions you already have open, as you. It never
logs on, never stores a password, and talks only to your SAP front end
(SAP GUI, or Chrome through its DevTools protocol), the MCP client that
started it, and, with the `diag` method, the SAP system it relays SAP GUI's
traffic to. It sends no telemetry.

Its guard checks every action before it runs:

- **Writes:** each surface classifies an action as read, navigate or
  commit, and fails closed: anything not known to be safe is a commit.
  Commits are refused (`SAP_WRITE=off`, the default), held for your yes
  (`confirm`), or allowed (`on`).
- **Where:** allow lists of systems and clients, of browser origins, and
  allow and block lists of transactions, checked on every call.
- **The command field** takes commands only through the `okcode` action, so
  a command cannot go round the transaction lists.
- **Logons:** password fields cannot be typed into, and nothing runs on a
  logon screen.
- **Confirmations** are bound to the session, system, client, transaction,
  window title and action, checked again before the action runs, used once,
  and expire after ten minutes.

## What the guard does not protect against

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
  cannot ask gets every write refused. With `SAP_WRITE=on`, the only check
  left is your client's own approval of each `sap_act` call, which you
  configure in the client.
- **What the agent reads leaves the server.** Screen content goes to your
  MCP client and the model behind it. The guard does not stop the agent
  from passing what it read to other tools it has.
- **Screen content is not trusted input.** Texts in SAP (a material's long
  text, a note on an order) could hold instructions aimed at the agent. The
  guard still applies to every action, but read-only access to data can be
  misused by an agent that follows such text.
- **Remote debugging opens the whole browser.** The server reads only tabs
  it recognises as SAP (and only `SAP_ALLOW_ORIGINS`, when set), but any
  program that can reach the browser's DevTools endpoint can read every
  tab. Use a separate Chrome profile for SAP work.
- **The `diag` method** runs a SAProuter on `127.0.0.1` (port 3298 by
  default). Any program on the same machine can connect to it and pass
  traffic to the next hop of a route. It reads SAP GUI traffic in the
  clear, which is why it cannot work with SNC. `SAP_DIAG_CAPTURE` writes
  that traffic to disk, logon included: use it only to debug, on your own
  machine, and delete the files afterwards.
- **Recordings hold what was typed.** `sap_record` files (in
  `SAP_RECORD_DIR`) contain the values entered during the run. Treat them
  like the system's data.
- **The server process runs as you.** On Windows it starts Windows
  PowerShell to reach SAP GUI; `setup` edits your MCP clients'
  configuration files (keeping a `.bak`).
