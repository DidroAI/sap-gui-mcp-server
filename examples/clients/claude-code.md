# Claude Code

```sh
claude mcp add sap-ui-automation --scope user -- npx -y sap-ui-automation
```

Or the plugin, which adds the `sap-ui-automation` skill as well:

```text
/plugin marketplace add DidroAI/sap-ui-automation
/plugin install sap-ui-automation@sap-ui-automation
```

By default (`SAP_WRITE=confirm`) the agent can prepare writes that you
approve one by one. For a read-only server:

```sh
claude mcp add --scope user --env SAP_WRITE=off --transport stdio sap-ui-automation -- npx -y sap-ui-automation
```

Claude Code asks in interactive sessions; in `claude -p` a write under
`confirm` does not run unless a hook answers. Check with `/mcp` in a session. More: [installation](../../docs/getting-started/installation.md#claude-code).

## Try

- "Look at my SAP screen and list the required fields that are still empty."
- "Open VA03 for sales order 4711 and summarise the items, quantities and net values in a table. Read only."
- With the default `SAP_WRITE=confirm`: "In the open VA02 order, set the requested delivery date of item 10 to next Monday. Ask me before you save."
