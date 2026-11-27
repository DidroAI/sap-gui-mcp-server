---
title: "Your first SAP session with an AI agent"
description: "Log on to SAP yourself, ask the agent to look at the screen, and check your write settings: the first steps after installing sap-ui-automation."
---

# Your first session

Your first session goes in four steps: log on to SAP, ask the agent in
plain words, watch it work with a few tools, and check how your client handles writes. This page assumes the server is added to your MCP client
([Install in your client](installation.md)) and that
`npx -y sap-ui-automation doctor` says Ready.

## 1. Open SAP and log on

Open the SAP screen you want to work in and log on yourself: an SAP GUI
window, a Web GUI tab or a Fiori launchpad tab in Chrome. The server never
logs on, never types a password, and refuses every action on a logon
screen. (With the Chrome extension, the agent can ask the extension to log
on to a system you registered: [Chrome](../guides/chrome.md#use-your-everyday-chrome-with-the-extension).)

To check what the server finds, outside the agent:

```sh
npx -y sap-ui-automation sessions
```

## 2. Ask the agent

Ask in plain words, for example:

- *"Look at my SAP screen and tell me which fields are required."*
- *"In VA03, open order 19097 and tell me its delivery status."*
- *"In SE16N, show me the first 20 rows of table T001 with their company
  code and currency."*
- *"In the Fiori launchpad, open Manage Sales Orders and list the orders of
  customer 17100001."*

## 3. What happens

The agent works with a few tools (all of them: [MCP tools](../reference/tools.md)):

1. **`sap_sessions`** lists the SAP sessions open on this machine, with
   surface, system, client, user, transaction and title. `*` marks the
   active one. When several are open, the agent picks one with **`sap_use`**
   (by number, id, system, transaction, or surface: `sapgui`, `webgui`,
   `fiori`).
2. **`sap_look`** returns the active screen as text: a header (transaction,
   program, screen, system), then one line per control. See
   [The screen view](../concepts/screen-view.md).
3. **`sap_act`** runs one action on an id from that view, such as
   `{"do":"okcode","value":"/oVA03"}` to open VA03 in a new GUI session.
   Verify the new session in `sap_sessions`, then pass its exact id on each
   call. On VA03 use
   `{"do":"set","id":"ctxtVBAK-VBELN","value":"19097"}`, then
   `{"do":"key","key":0}` (Enter). Each action answers with the new screen,
   or with only what changed when the screen is the same one, so the agent
   rarely needs `sap_look` in between. See [Actions](../concepts/actions.md).

After every action the agent should read the status bar line (`sbar  status
E: ...`): SAP reports errors (`E`), warnings (`W`) and successes (`S`)
there. An error, a warning or a termination is also put at the top of the
answer, with what to do about it.

Calls on one session run one at a time: a second call waits for the first
to end, and its answer says how long it waited.

`sap_screenshot` gives a PNG of the window or tab, for charts and panels
the text view cannot read.

A named transaction is not permission to discard the current screen. `/nVA03`
replaces it and can lose unsaved input. Use that shortcut only in a known
clean session or when the user has authorized discarding the input.

## 4. Check your write settings

With the default `SAP_WRITE=confirm`, the server requests approval for
actions it identifies as possible writes. An interactive client can show you
the request. A client without elicitation gets a refusal. Codex Full Access
can accept automatically. [Client-specific behavior](../concepts/confirm-mode.md)

To change this, set `SAP_WRITE` in the server's environment:

- `SAP_WRITE=off`: read-only. Every such action is refused, without a
  question. Use it to be sure nothing is saved, and in Codex's Full Access
  mode, which accepts the question without showing it to you.
- `SAP_WRITE=on`: such actions run. With a client that cannot ask, on a
  test system, together with the client's own approval of each `sap_act`
  call.

For example, in Claude Code:

```sh
claude mcp add sap-ui-automation --scope user -e SAP_WRITE=off -- npx -y sap-ui-automation
```

Other clients take it in their `env` block ([Install in your
client](installation.md)). Restart the client after a change. Use a test
system and a user with the authorisations you want the agent to have:
[Safety model](../concepts/safety.md) says what the rules catch and what
they do not.

## Tips for the agent

The [`sap-ui-automation` skill](https://github.com/DidroAI/sap-ui-mcp/blob/main/skills/sap-ui-automation/SKILL.md)
teaches an agent how SAP screens behave: fields take effect on Enter,
popups first, value help (F4) instead of guessed codes, F3 or F12 to leave
without saving, and never working around the write setting. `setup` and
the Claude Code plugin install it; `sap-ui-automation install --skills`
puts it in a project. It also ships in the npm package, under `skills/`.
