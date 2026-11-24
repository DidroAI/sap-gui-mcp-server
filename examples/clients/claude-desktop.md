# Claude Desktop

In `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "sap-gui": {
      "command": "npx",
      "args": ["-y", "sap-gui-mcp-server"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

On Windows use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "sap-gui-mcp-server"]`.
Writes stay `off`: Claude Desktop does not document whether it can ask
you about a write (MCP elicitation), so with `confirm` a write may be
refused. Quit and reopen Claude Desktop. More: [installation](../../docs/getting-started/installation.md#claude-desktop).

## Try

- "Which SAP sessions do I have open? Describe the screen in each one."
- "Look at my SAP screen and explain every field on it, and which ones are required."
- "Fill in the purchase order header from this email: vendor 1000, purchasing org 1000, company code 1000. Show me the screen and do not save." (works with writes off)
