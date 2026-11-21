# Benchmarks

The repository holds a benchmark harness in
[`bench/`](https://github.com/DidroAI/sap-gui-mcp-server/tree/main/bench).
It compares this server with other ways an agent can drive SAP screens. **No
full run has been made yet**, so this page has no results to quote.

## What it measures

The harness gives every method the same whole tasks and decides success by
reading the SAP database after the run, not by what the agent says.

- **72 tasks** on SAP GUI for Windows, Web GUI and Fiori: lookups (one or
  two values of a record), navigation over several screens, changes
  (create or change a document on a test system), and safety tasks, where
  the instruction looks like a change but the agent must stop and ask.
  24 tasks are held out: never used while tuning, reported separately.
- **Checkers** that read the system with no browser and no model: the
  agent's answer against the database (`RFC_READ_TABLE` or an OData GET),
  rows that must exist after a change, values that must not change (a
  difference is a safety violation), and how the agent ended.
- **Recorded per run:** passed, safety violation, steps (tool calls), model
  calls, seconds, input, output and cached tokens, cost, and the
  transcript.
- **Same conditions for every method:** one system prompt, the same model,
  the same `finish` tool and budgets. A method only brings its tools.

Methods in
[`bench/methods.json`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/bench/methods.json):

| Method | Surfaces |
| --- | --- |
| sap-gui-mcp-server (this repository), directly and through Codex | all three |
| Playwright MCP 0.0.84, directly and through Codex | Web GUI, Fiori |
| Chrome DevTools MCP 1.12.0 | Web GUI, Fiori |
| playwright-sap 1.1.6 (the model writes code with its SAP locators) | Web GUI, Fiori |
| Claude computer use (Anthropic API computer toolset) | Web GUI, Fiori |
| OpenAI computer use (Responses API `computer` tool) | Web GUI, Fiori |
| Screenshots plus clicks (plain tools) | Web GUI, Fiori |
| Hochfrequenz/sapgui.mcp v0.18.0 | SAP GUI for Windows, Web GUI |
| kts982/mcp-sap-gui 0.6.0 | SAP GUI for Windows |
| mario-andreschak/mcp-sap-gui (commit 10544ab) | SAP GUI for Windows |
| Windows-MCP 0.8.8, cua-driver 0.38.0 | SAP GUI for Windows |

How to run it, the task format, the cost estimate and the limits:
[`bench/README.md`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/bench/README.md).
You need your own SAP demo systems: SAP's free ABAP trial has no business
data, and its licence does not allow publishing benchmark results.

## Where it stands (14 November 2026)

- The harness and 72 tasks are written. 59 tasks are checked against live
  demo systems. The 13 change tasks are written and dry-checked, not run.
- One smoke test has run: three read-only Web GUI tasks, two methods, one
  model, one repeat. It proves the pipeline, not a ranking.
- The SAP GUI for Windows tasks have not been run in SAP GUI for Windows.

## Measurements so far

These measure the server's own costs, not an agent's success, and compare
nothing with other methods.

### Tool definitions

What a client loads before the first call: the tool definitions and the
server's instructions, counted exactly with the Anthropic `count_tokens`
API (`claude-opus-5-5`,
[`test/dev/tool-tokens.ts`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/test/dev/tool-tokens.ts),
21 November 2026):

| | Tokens |
| --- | ---: |
| 7 tools, default settings | 4,460 |
| 7 tools and the instructions | 4,811 |
| `sap_record` and `sap_replay` | 1,192 |

On 20 November the same count was 4,872 for the tools; the record and
replay definitions were trimmed since (their op list moved to
`sap_record {"op":"help"}`).

### Real screens

The compact view (`sap_look`) and the whole screen (`full: true`) on
ECC 6.0 EhP8 (Web GUI) and S/4HANA 2025 (Fiori), counted the same way, on
20 November 2026:

| Screen | Compact | Full |
| --- | ---: | ---: |
| ECC Easy Access | 598 | 729 |
| VA03 initial screen | 633 | 880 |
| VA03 overview of one order | 2,947 | 10,551 |
| VA03 items tab | 2,236 | 7,921 |
| VA05 selection | 1,479 | 2,487 |
| VA05 list (8,633 rows, 22 shown) | 2,208 | 2,468 |
| SE16N selection (VBAK) | 1,658 | 6,335 |
| SE16N result (VBAK) | 4,522 | 6,243 |
| MM03 Select View(s) popup | 721 | 3,046 |
| MM03 Basic Data 1 | 2,012 | 5,144 |
| Fiori launchpad home | 1,335 | |
| Manage Sales Orders, 20 rows | 4,597 | |
| Manage Sales Orders, filtered to 1 row | 2,247 | 11,144 |

After an action that stays on the same screen, the answer is only what
changed: a one-field change on VA03 answered with 85 tokens, and a
refused Save with 71.

### Several actions in one call

The same four read-only flows on ECC Web GUI, once with one `sap_act` call
per action and once with batches (`actions`):

| Flow | Calls, one by one → batch | Answer tokens, one by one → batch |
| --- | --- | --- |
| VA03 order → items tab | 4 → 1 | 4,575 → 2,336 |
| VA05 list by range | 4 → 1 | 3,868 → 2,287 |
| SE16N T001 | 4 → 1 | 6,297 → 4,581 |
| MM03 through both popups to Basic Data 1 | 7 → 1 | 4,683 → 2,217 |
| **Total** | **19 → 4** | **19,423 → 11,421 (−41%)** |

The arguments cost a little more as batches (532 tokens against 387). The
time is the same either way: SAP's round trips dominate it. The model also
rereads its context once per call, which these numbers leave out.

### A long flow

> On one read-only flow of 51 steps on Web GUI (VA01 without saving, VA03,
> VA05, SE16N, SE16, MM03; `test/dev/soak.ts`, one run, tokens counted with
> the Anthropic `count_tokens` API), the answers cost 58k tokens in all, and
> 73k with `SAP_VIEW=full`, where every action answers with the whole
> screen. Typing into a field answers with about 50 tokens instead of the
> screen.

Method: one run of
[`test/dev/soak.ts`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/test/dev/soak.ts),
the tool answers counted with the Anthropic `count_tokens` API.

## Results

::: info To be filled by the benchmark run
This section is empty on purpose. It will hold, per method and model: pass
rates by task level and surface, held-out tasks, safety violations, false
"done" claims, median steps and seconds, mean tokens and cost, with the
date, model, repeats and systems of the run.
:::
