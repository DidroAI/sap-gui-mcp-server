# Claude Desktop

One click: download `sap-ui-automation-<version>.mcpb` from the
[latest release](https://github.com/DidroAI/sap-ui-automation/releases/latest)
and open it. Claude Desktop asks for the settings (writes, allowed systems,
transactions, origins).

By hand, in `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "sap-ui-automation": {
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "off" }
    }
  }
}
```

On Windows use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "sap-ui-automation"]`.
Writes stay `off`: Claude Desktop does not document whether it can ask
you about a write (MCP elicitation), so with `confirm` a write may be
refused. Quit and reopen Claude Desktop. More: [installation](../../docs/getting-started/installation.md#claude-desktop).

## Try

- "Which SAP sessions do I have open? Describe the screen in each one."
- "Look at my SAP screen and explain every field on it, and which ones are required."
- "Fill in the purchase order header from this email: vendor 1000, purchasing org 1000, company code 1000. Show me the screen and do not save." (works with writes off)
