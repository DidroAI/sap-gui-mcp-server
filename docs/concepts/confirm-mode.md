# Confirm mode

With `SAP_WRITE=confirm`, an action that may write runs only after you say
yes to it in your MCP client. Every other action runs as usual. The client
must support MCP elicitation; with one that does not, such actions are
refused.

## The client supports MCP elicitation

The server asks you in the client itself, with the action, the system, the
transaction and the window title:

```
Allow this action in SAP? It may write to the system.

What: <what the server says the action does>
Where: <system>/<client>, <transaction> ("<window title>") [<window or tab>]
Action: <the action>
```

The action runs only if you accept. The agent cannot answer for you. If you
decline or dismiss the question, the action is not run and the agent is
told so. You have five minutes to answer.

## Which clients can ask

Checked on 21 November 2026 from each client's changelog, documentation and
source. Clients change quickly: try a harmless write on a test system first.

| Client | Asks? | Notes |
| --- | --- | --- |
| Claude Code | yes, from 2.1.76 | In interactive sessions. In `claude -p` (headless) only an `Elicitation` hook or the Agent SDK's `onElicitation` can answer; otherwise the question is cancelled and the write does not run. |
| VS Code (GitHub Copilot, Agent mode) | yes, from 1.102 | The question appears in the chat. |
| Codex (CLI, IDE extension, app) | yes, from 0.119 | `codex exec` cancels every question, so writes do not run there. **In Full Access mode (approvals set to never), Codex accepts these questions without showing them**: there `confirm` protects nothing; use `off`. |
| Cursor | supported since 1.5, unreliable | Users report the question never showing on Windows, its buttons hidden until the tool row is expanded, and a timeout of about a minute. Test it before relying on it; else keep `off`. |
| Claude Desktop | not documented | No statement either way for the chat. Keep `off`; with `confirm`, a write is refused if Claude Desktop does not ask. |
| Windsurf / Devin Desktop | not checked | Keep `off` until you have tried it. |
| The agent CLI (`sap-gui act`) | no | It cannot ask: writes need `SAP_WRITE=on`. |

Sources: the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
and [MCP docs](https://code.claude.com/docs/en/mcp);
[VS Code 1.102 release notes](https://code.visualstudio.com/updates/v1_102);
Codex [PR 17043](https://github.com/openai/codex/pull/17043),
[PR 17164](https://github.com/openai/codex/pull/17164) and
[`exec`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs);
[Cursor 1.5 changelog](https://cursor.com/changelog/1-5) and its
[forum](https://forum.cursor.com/t/mcp-elicitation-create-hangs-agent-on-windows-in-cursor-3-10-20-but-works-on-macos/165391);
[claude-ai-mcp issue 153](https://github.com/anthropics/claude-ai-mcp/issues/153).

## The client does not

Then the server cannot ask you, and an action that may write is
**refused**, as with `SAP_WRITE=off`:

```
Refused: this action may write to SAP (<what it does>) and writing is set to confirm, but this client cannot ask the user (it does not support MCP elicitation). Nothing ran. ...
```

The agent is told to say what it would have saved and not to look for
another way. The first `sap_look` or `sap_act` answer of the session starts
with a `NOTE:` line that says writes will be refused, so the agent can tell
you before it works towards a save. The server also writes the same note
once to its log (stderr) when the client connects.

With such a client, use `SAP_WRITE=on` together with the client's own
approval of each `sap_act` call (most clients ask before a tool that is
marked destructive). That approval is then the check; the server does not
add one of its own. In Claude Code, leave `mcp__sap-gui__sap_act` out of
`permissions.allow` (or put it in `ask`); in Codex, set
`approval_mode = "prompt"` for that tool. That approval covers every
`sap_act` call, not only the ones that write.

## What the confirmation is bound to

The question is bound to what it showed: the session, system, client,
transaction, window title, the action and what the server said it would
do. Before running, the server reads the screen again and refuses if any
of these changed, with what changed; the agent then looks at the screen
and calls `sap_act` again.

## In a batch

In a batch (`actions`), the action that may write is asked about on its
own, when its turn comes. If you decline, the batch ends there with
`Not run: the user declined`. With a client that cannot ask, the batch ends
there with the refusal.

## Limits

This is a safety net, not a guarantee. A custom button whose name is on the
safe list can still write, and so can a report started with F8: neither is
held, because the server does not rate them as writes
([Safety model](safety.md)). Use a test system and a user with the
authorisations you want the agent to have.

A recorded test that is replayed, and the [agent CLI](../guides/cli-for-agents.md),
cannot ask for each step: a step that may write needs `SAP_WRITE=on` ([Recording and replay](../guides/record-replay.md)).
