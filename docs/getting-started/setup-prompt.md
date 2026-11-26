---
title: "Set up the SAP MCP server with your AI agent"
description: "A prompt to paste into Claude Code, Codex or another agent with a terminal: it installs sap-ui-automation, runs doctor and walks you through each setting."
---

# Set up with your agent

Paste this prompt into Claude Code, Codex, Cursor, or any agent that can
run commands on your machine. The agent installs the server, adds it to
your coding agents, runs `doctor`, walks you through what is missing one
step at a time, and ends with a short report.

What the prompt does not let the agent do:

- type or ask for an SAP password, or log on to SAP for you;
- change `SAP_WRITE`: writes stay at the default, `confirm`, where each
  write waits for your yes;
- save, post or delete anything in SAP: it only reads the screen at the
  end;
- install software or change SAP GUI options without telling you first.

```text
Set up sap-ui-automation for me (npm package sap-ui-automation, https://github.com/DidroAI/sap-ui-automation). Work step by step. Before each command, say in one sentence what it does. Wait for me whenever I have to click something or decide.

Rules for the whole task:
- Never type, ask for or store an SAP password, and never log on to SAP for me. I log on myself.
- Do not set or change SAP_WRITE. The default (confirm) asks me before each write.
- Do not save, post, delete or change anything in SAP. Only read screens.
- Do not install software or change system settings without asking me first.

1. Run: node -v
   If Node.js is missing or older than 22, tell me how to install Node.js 22 or later for my operating system, and stop until I confirm.
2. Run: npx -y sap-ui-automation setup --dry-run
   Show me which agents it would set up. If I want only some of them, use their ids (for example: setup claude-code). Then run the same command without --dry-run.
3. Run: npx -y sap-ui-automation doctor
   For each line marked ✗, tell me in plain words what to do (the → line under it says it), wait for me to do it, then run doctor again. Typical steps:
   - Web GUI or Fiori in Chrome: if doctor says Chrome was not found, I have to install Google Chrome (or you set SAP_CHROME_PATH to its program file). Then run: npx -y sap-ui-automation browser
     A Chrome window opens (the SAP window). Ask me to open my SAP address there and log on, and wait until I say it is done.
   - SAP GUI for Windows: ask me to open SAP GUI options, Accessibility & Scripting > Scripting, tick "Enable scripting", untick the two "Notify when a script..." boxes, and restart SAP Logon. If doctor says scripting is not allowed on the SAP system, tell me that my SAP Basis team has to set sapgui/user_scripting = TRUE, and go on.
   - If I use only one of the two, skip the other's ✗ lines.
4. Ask me to open one SAP screen. Then run: npx -y sap-ui-automation sessions
   and, if it lists a session, run: npx -y sap-ui-automation look --print
   Describe the screen you see in three lines.
5. Report, in at most ten lines:
   - the version (npx -y sap-ui-automation --version) and the agents setup changed;
   - each doctor area with ✓ or ✗, and what is still left for me to do;
   - whether I have to restart this agent (or other agents) to get the MCP tools;
   - how writes work: by default the server asks me before anything that may save in SAP, and refuses it if the client cannot ask; the sap-gui command line refuses every write; SAP_WRITE=off makes the server read-only.
```

After the restart, try: *"Look at my SAP screen and tell me which fields
are required."* ([Your first session](first-session.md))

## Notes

- `setup` run by an agent has no terminal to ask in, so it sets up every
  coding agent it finds. Name agents to limit it
  ([setup](../reference/cli.md#setup)).
- For the Chrome extension instead of the SAP window, add the extension
  from the
  [Chrome Web Store](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn)
  and tell the agent to run `setup --extension` in step 2
  ([steps](../guides/chrome.md#install-the-extension)).
- To use a build from a checkout instead of npm (see
  [CONTRIBUTING.md](https://github.com/DidroAI/sap-ui-automation/blob/main/CONTRIBUTING.md)),
  run `npm link` in the checkout after `bun run build`, and replace
  `npx -y sap-ui-automation` with `sap-ui-automation` in the prompt.
