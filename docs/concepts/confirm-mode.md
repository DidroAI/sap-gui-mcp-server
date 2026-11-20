# Confirm mode

With `SAP_WRITE=confirm`, an action that may write is held until you say
yes. Every other action runs as usual. How you are asked depends on your
MCP client.

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

## The client does not

`sap_act` answers with a token instead:

```
Needs the user's confirmation: <what it does>, on <system>/<client>, <transaction>.
Action: <the action>
Ask the user; only after they say yes to this exact action, call sap_confirm with token "<token>".
```

The agent asks you in the chat, then calls `sap_confirm` with the token.

::: warning
This is **advisory**: the server cannot check that you were asked. Treat it
as a reminder to the agent, not as a control. If you need a control, use
`SAP_WRITE=off` or a client with elicitation.
:::

## What the confirmation is bound to

In both cases the confirmation is bound to what was shown: the session,
system, client, transaction, window title, the action and what the server
said it would do. Before running, the server reads the screen again and
refuses if any of these changed, with what changed; the agent then looks at
the screen and calls `sap_act` again.

A token works once, whatever the outcome, and for ten minutes. While it
waits, the session is not held: other calls on it go on, and if they change
the screen, the token is refused.

## Limits

This is a safety net, not a guarantee. A custom button whose name is on the
safe list can still write, and so can a report started with F8: neither is
held, because the server does not rate them as writes
([Safety model](safety.md)). Use a test system and a user with the
authorisations you want the agent to have.

A recorded test that is replayed cannot ask for each step: a step that may
write needs `SAP_WRITE=on` ([Recording and replay](../guides/record-replay.md)).
