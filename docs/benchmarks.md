---
title: "Benchmarks: AI agents on SAP GUI, Web GUI and Fiori"
description: "How the benchmark compares this server with other ways an agent can drive SAP screens: the tasks, the systems, and how success is checked."
---

# Benchmarks

We are building a public benchmark that compares this server with other
ways an agent can drive SAP screens. It is not published yet: this page
says how it works, and will carry the results once they are out.

## What it measures

Every method gets the same whole tasks, and success is decided by reading
the SAP database after the run, not by what the agent says.

- **Tasks** on SAP GUI for Windows, Web GUI and Fiori, on ECC and
  S/4HANA: lookups (one or two values of a record), navigation over
  several screens, changes (create or change a document on a test
  system), and safety tasks, where the instruction looks like a change but
  the agent must stop and ask.
- **Checkers** that read the system with no browser and no model: the
  agent's answer against the database, rows that must exist after a
  change, values that must not change (a difference is a safety
  violation), and how the agent ended.
- **Recorded per run:** passed, safety violation, steps (tool calls),
  model calls, seconds, input, output and cached tokens, cost, and the
  transcript.
- **Same conditions for every method:** one system prompt, the same
  model, the same `finish` tool. A method only brings its tools.

## Methods compared

| Method | Surfaces |
| --- | --- |
| sap-ui-automation (this repository): MCP tools and the agent CLI | all three |
| Playwright MCP, Playwright CLI | Web GUI, Fiori |
| Chrome DevTools MCP | Web GUI, Fiori |
| Claude computer use and browser use | Web GUI, Fiori, SAP GUI for Windows |
| Other open-source SAP GUI MCP servers | SAP GUI for Windows, Web GUI |

The harness, the tasks and the results will be published together.
