---
layout: home
title: "SAP UI Automation: an MCP server for SAP GUI, Web GUI and Fiori"
titleTemplate: false
description: "Let Claude, Codex, Cursor and other AI agents see and drive the SAP screens you have open: SAP GUI for Windows, Web GUI and Fiori. Each write waits for your yes."
hero:
  name: SAP UI Automation
  text: Let your agent see and drive SAP
  tagline: SAP GUI for Windows, Web GUI and Fiori, in a compact text view, with each write held for your yes. Runs on your machine.
  actions:
    - theme: brand
      text: Choose your setup
      link: /getting-started/choose
    - theme: alt
      text: Install in your client
      link: /getting-started/installation
    - theme: alt
      text: GitHub
      link: https://github.com/DidroAI/sap-ui-automation
features:
  - title: The screens you already have open
    details: Finds your SAP GUI, Web GUI and Fiori sessions and works in them as you, under your SAP authorisations. It never sees a password. You log on, or the Chrome extension types the password itself.
  - title: A compact, complete view
    details: One line per control with SAP's own ids, labels, values and whether they can be edited. After an action on the same screen, only what changed.
  - title: You confirm each write
    details: An action that may save to SAP waits for your yes in your client, and is refused where the client cannot ask. SAP_WRITE=off makes it read-only.
  - title: Runs locally, no telemetry
    details: Nothing leaves your machine except what your MCP client sends to the model provider you chose.
  - title: Record a run, replay it as a test
    details: An agent's run becomes a file that replays with no model, and exports to the formats test teams use.
  - title: Every MCP client
    details: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, VS Code and any other client that starts a stdio server; a command line for agents without MCP.
---
