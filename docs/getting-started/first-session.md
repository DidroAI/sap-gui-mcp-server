# Your first session

This page assumes the server is added to your MCP client
([Install in your client](installation.md)) and that
`npx -y sap-gui-mcp-server doctor` says Ready.

## 1. Open SAP and log on

Open the SAP screen you want to work in and log on yourself: an SAP GUI
window, a Web GUI tab or a Fiori launchpad tab in Chrome. The server never
logs on, never types a password, and refuses every action on a logon
screen.

To check what the server finds, outside the agent:

```sh
npx -y sap-gui-mcp-server sessions
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
   `{"do":"okcode","value":"/nVA03"}` or
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

## 4. Writes are off

By default every action that may write to SAP (Save, Post, Delete, Release,
Approve, "Yes" on a save popup...) is refused, and the agent is told why.
Everything else (typing, Enter, tabs, Back, value help, reports with F8)
runs. A refused action changes nothing.

To let the agent save, set `SAP_WRITE` in the server's environment:

- `SAP_WRITE=confirm`: each such action is held until you say yes
  ([Confirm mode](../concepts/confirm-mode.md)). Start here.
- `SAP_WRITE=on`: such actions run.

For example, in Claude Code:

```sh
claude mcp add sap-gui --scope user -e SAP_WRITE=confirm -- npx -y sap-gui-mcp-server
```

Other clients take it in their `env` block ([Install in your
client](installation.md)). Restart the client after a change. Use a test
system and a user with the authorisations you want the agent to have:
[Safety model](../concepts/safety.md) says what the rules catch and what
they do not.

## Tips for the agent

The [`sap-gui-drive` skill](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/skills/sap-gui-drive/SKILL.md)
teaches an agent how SAP screens behave: fields take effect on Enter,
popups first, value help (F4) instead of guessed codes, F3 or F12 to leave
without saving, and never working around the write setting. The Claude Code
plugin installs it; for other agents, copy the folder into their skills
directory (for Claude Code without the plugin: `~/.claude/skills/`). It
also ships in the npm package, under `skills/`.
