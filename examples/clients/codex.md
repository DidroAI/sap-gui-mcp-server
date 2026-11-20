# Codex

```sh
codex mcp add sap-gui -- npx -y sap-gui-mcp-server
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sap-gui]
command = "npx"
args = ["-y", "sap-gui-mcp-server"]

[mcp_servers.sap-gui.env]
SAP_WRITE = "confirm"   # off (default) | confirm | on
```

The CLI, the IDE extension and the desktop app share this file. More:
[installation](../../docs/getting-started/installation.md#codex).

## Try

- "Look at my SAP screen and list the required fields, with their technical names."
- "In the open SE16N session, show the first 20 rows of table MARA for material type FERT and write them to mara.csv."
- With `SAP_WRITE=confirm`: "Record what I do in MM02 as a test, then replay it once with material 4711. Ask me before each save."
