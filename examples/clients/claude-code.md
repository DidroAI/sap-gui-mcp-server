# Claude Code

```sh
claude mcp add sap-gui --scope user -- npx -y sap-gui-mcp-server
```

Or the plugin, which adds the `sap-gui-drive` skill as well:

```text
/plugin marketplace add DidroAI/sap-gui-mcp-server
/plugin install sap-gui@sap-gui-mcp-server
```

To let the agent prepare writes that you approve one by one:

```sh
claude mcp add --scope user --env SAP_WRITE=confirm --transport stdio sap-gui -- npx -y sap-gui-mcp-server
```

Check with `/mcp` in a session. More: [installation](../../docs/getting-started/installation.md#claude-code).

## Try

- "Look at my SAP screen and list the required fields that are still empty."
- "Open VA03 for sales order 4711 and summarise the items, quantities and net values in a table. Read only."
- With `SAP_WRITE=confirm`: "In the open VA02 order, set the requested delivery date of item 10 to next Monday. Ask me before you save."
