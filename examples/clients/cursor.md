# Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=sap-gui&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNhcC1ndWktbWNwLXNlcnZlciJdfQ%3D%3D)

Or in `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

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

Check under Settings > MCP. More: [installation](../../docs/getting-started/installation.md#cursor).

## Try

- "Look at my SAP screen and list the required fields that are still empty."
- "Read the error message on my SAP screen and find where it comes from in this repository's ABAP sources."
- With `"SAP_WRITE": "confirm"`: "Enter the test data from fixtures/order.json into the open VA01 screen. Stop and ask me before saving."
