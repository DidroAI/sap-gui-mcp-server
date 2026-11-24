# VS Code (GitHub Copilot)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_sap--ui--automation-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sap-ui-automation%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sap-ui-automation%2522%255D%257D)

Or in the Copilot user file, `~/.copilot/mcp-config.json` (also read by the
Copilot CLI), or `.mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "sap-ui-automation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_WRITE": "confirm" },
      "tools": ["*"]
    }
  }
}
```

`confirm` makes VS Code ask you in the chat before each write (VS Code
1.102 or later); `off` refuses writes.

The editor's own format (`code --add-mcp`, `.vscode/mcp.json`) uses `servers`
instead of `mcpServers`. More: [installation](../../docs/getting-started/installation.md#vs-code-github-copilot).

## Try

In Copilot Chat, Agent mode:

- "Look at my SAP screen and list the required fields that are still empty."
- "Open the Fiori app on my screen and describe the filters and the columns of the list."
- With `"SAP_WRITE": "confirm"`: "Change the payment terms of customer 1000 in the open XD02 screen to 0001. Ask me before you save."
