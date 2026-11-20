# Claude Desktop

One click: download `sap-gui-mcp-server-<version>.mcpb` from the
[latest release](https://github.com/DidroAI/sap-gui-mcp-server/releases/latest)
and open it. Claude Desktop asks for the settings (writes, allowed systems,
transactions, origins).

By hand, in `claude_desktop_config.json` (Settings > Developer > Edit Config):

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
Quit and reopen Claude Desktop. More: [installation](../../docs/getting-started/installation.md#claude-desktop).

## Try

- "Which SAP sessions do I have open? Describe the screen in each one."
- "Look at my SAP screen and explain every field on it, and which ones are required."
- With `SAP_WRITE=confirm` (set it in the extension's settings): "Fill in the purchase order header from this email: vendor 1000, purchasing org 1000, company code 1000. Show me the screen before anything is saved."
