# Set up with your agent

Paste this into Claude Code, Codex, or any agent that can run commands on
your machine. It installs the server, adds it to your MCP clients and walks
you through the settings SAP and Chrome need, one at a time.

```text
Set up the sap-gui MCP server (npm package sap-gui-mcp-server) on this machine for me, step by step. Explain each step in one sentence before you run it, and wait for me whenever I have to click something.

1. Check that Node.js 22 or later is installed (node -v). If it is missing or older, tell me how to install it for my operating system and stop until I confirm.
2. Run: npx -y sap-gui-mcp-server setup --dry-run
   Show me what it would change, then run it without --dry-run.
3. Run: npx -y sap-gui-mcp-server doctor
   For each line marked ✗, tell me in plain words what to do (the → line says it), wait for me to do it, then run doctor again. Typical steps:
   - Chrome (for Web GUI and Fiori): if doctor says Google Chrome was not found, I have to install it (or you set SAP_CHROME_PATH to its program file). Nothing has to be switched on in Chrome.
   - Then run: npx -y sap-gui-mcp-server browser
     A Chrome window opens (the SAP window). Ask me to open my SAP address there (Web GUI or the Fiori launchpad) and to log on, and wait until I say it is done.
   - SAP GUI for Windows: in SAP GUI options, Accessibility & Scripting → Scripting, tick "Enable scripting" and untick the two "Notify when a script…" boxes, then restart SAP Logon. If doctor says scripting is not allowed on the SAP system, I need my SAP basis team to set sapgui/user_scripting = TRUE: tell me so and go on.
4. When doctor says Ready, ask me to open an SAP screen (in SAP GUI, or Web GUI or Fiori in the SAP window), and to restart this agent if setup said so. Then call sap_sessions and sap_look, and describe the screen you see in three lines.
5. Tell me how writes work: by default the server refuses anything that may save in SAP; SAP_WRITE=confirm makes it ask me first. Do not change that setting unless I ask.

Never type an SAP password and never log on to SAP for me: I log on myself.
```

To use a build from a checkout instead of npm (see
[CONTRIBUTING.md](../CONTRIBUTING.md)), run `npm link` in the checkout after
`bun run build`, and replace `npx -y sap-gui-mcp-server` with
`sap-gui-mcp-server` in the prompt.
