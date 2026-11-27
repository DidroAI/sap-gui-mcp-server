# Codex

```sh
codex mcp add sap-ui-automation -- npx -y sap-ui-automation
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sap-ui-automation]
command = "npx"
args = ["-y", "sap-ui-automation"]

[mcp_servers.sap-ui-automation.env]
SAP_WRITE = "confirm"   # confirm (default) | off (read-only) | on
```

`confirm`, the default, makes Codex ask you before each write (Codex 0.119 or later).
`codex exec` cancels such questions, so the write does not run, and in
Full Access mode Codex accepts them without asking: use `off` there.

The CLI, the IDE extension and the desktop app share this file. More:
[installation](../../docs/getting-started/installation.md#codex).

## Try

- "Look at my SAP screen and list the required fields, with their technical names."
- "In the open SE16N session, show the first 20 rows of table MARA for material type FERT and write them to mara.csv."
- With `SAP_WRITE=confirm`: "In a clean test session, record yourself displaying material 4711 in MM03, check its description, then replay the test."
