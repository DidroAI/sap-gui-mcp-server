---
title: "Benchmarks: AI agents on SAP GUI, Web GUI and Fiori"
description: "How the benchmark compares this server with other ways an agent can drive SAP screens: the tasks, the systems, and how success is checked."
---

# Benchmarks

Early results from our own benchmark harness: one model for most tables,
small samples, two lab systems. They show what this server costs and how
long it takes next to other ways an agent can drive SAP screens. They do
not show a reliable success ranking: see [Caveats](#caveats).

The harness and the raw results are not public yet. We plan to publish
them together.

## How the harness works

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

Methods the harness can run:

| Method | Surfaces |
| --- | --- |
| sap-ui-automation (this repository): MCP tools and the agent CLI | all three |
| Playwright MCP, Playwright CLI | Web GUI, Fiori |
| Chrome DevTools MCP | Web GUI, Fiori |
| Claude computer use and browser use | Web GUI, Fiori, SAP GUI for Windows |
| Other open-source SAP GUI MCP servers | SAP GUI for Windows, Web GUI |

Other open-source SAP GUI MCP servers are not in the results below.

## Method for these results

- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, effort medium), unless
  a table says otherwise.
- **Agent loop:** Claude Code for the MCP servers and the CLIs; the Claude
  API agent loop of the harness for computer use and browser use.
- **Procedure mode:** the agent gets the instruction plus a step-by-step
  procedure.
- **Pass:** the database checks for the scenario pass (document created,
  values posted, answer correct).
- **Invalid runs:** a run that could not start because the test data
  could not be set up is left out. It is not counted as a failure.
- **Cost:** Claude Code's own `total_cost_usd` for methods run in Claude
  Code; list prices for computer use and browser use.
- **Tokens per run:** input + output + cache reads + cache writes.
- **$ / success:** total cost divided by passed runs.
- **Systems:** two lab systems, one SAP ECC and one S/4HANA, with our own
  test data.

## 1. Web GUI, all methods

Pilot of 2026-11-23. 57 process scenarios on ECC and S/4HANA Web GUI, one
run per scenario per system. Like for like: only the 104
scenario-and-system pairs where every method had a valid run.

| Method | Runs | Passed | Success | $ / run | $ / success | Tokens / run | Seconds / run | Steps / run |
|---|---|---|---|---|---|---|---|---|
| sap-ui-automation MCP | 104 | 93 | 89% | $0.0053 | $0.0060 | 208k | 22 | 9.9 |
| sap-ui-automation CLI | 104 | 91 | 88% | $0.0081 | $0.0092 | 356k | 39 | 15.3 |
| Claude computer use | 104 | 94 | 90% | $0.0082 | $0.0090 | 298k | 89 | 57.0 |
| Playwright CLI | 104 | 85 | 82% | $0.0156 | $0.0191 | 766k | 88 | 21.7 |
| Playwright MCP | 104 | 92 | 88% | $0.0241 | $0.0272 | 1,083k | 65 | 33.3 |
| Claude browser use | 104 | 87 | 84% | $0.0678 | $0.0811 | 1,955k | 183 | 128.2 |
| Chrome DevTools MCP | 104 | 92 | 88% | $0.0816 | $0.0923 | 1,925k | 75 | 42.0 |

All valid runs, not only the common pairs (106 to 110 runs per method),
give almost the same figures: MCP 88%, $0.0053/run; CLI 86%, $0.0081;
computer use 90%, $0.0082; Playwright CLI 82%, $0.0158; Playwright MCP
88%, $0.0240; browser use 83%, $0.0654; Chrome DevTools MCP 87%, $0.0800.

Invalid runs left out (start state could not be set up): computer use 33,
Playwright MCP 14, Playwright CLI 14, browser use 14, Chrome DevTools MCP
10, sap-ui-automation MCP and CLI 0.

## 2. Long scenarios on Web GUI

Same pilot. Long means the 16 scenarios where the sap-ui-automation MCP
needed 10 or more steps on ECC Web GUI in this pilot: FIN-01, FIN-07,
FIN-09, MD-01, MD-04, O2C-01, O2C-02, O2C-06, O2C-07, P2P-01, P2P-02,
P2P-03, P2P-04, P2P-06, REP-03, REP-07. ECC and S/4HANA, the 30
scenario-and-system pairs where every method had a valid run, one run
each.

| Method | Runs | Passed | Success | $ / run | $ / success | Tokens / run | Seconds / run | Steps / run |
|---|---|---|---|---|---|---|---|---|
| sap-ui-automation MCP | 30 | 27 | 90% | $0.0100 | $0.0111 | 449k | 39 | 18.2 |
| sap-ui-automation CLI | 30 | 26 | 87% | $0.0147 | $0.0170 | 741k | 72 | 26.4 |
| Claude computer use | 30 | 25 | 83% | $0.0154 | $0.0184 | 696k | 163 | 104.2 |
| Playwright CLI | 30 | 21 | 70% | $0.0280 | $0.0400 | 1,521k | 154 | 37.1 |
| Playwright MCP | 30 | 28 | 93% | $0.0564 | $0.0604 | 2,455k | 139 | 65.2 |
| Claude browser use | 30 | 22 | 73% | $0.1953 | $0.2663 | 4,853k | 323 | 224.3 |
| Chrome DevTools MCP | 30 | 26 | 87% | $0.2418 | $0.2790 | 5,042k | 170 | 87.3 |

## 3. sap-ui-automation MCP by surface

Runs of 2026-11-25 and 2026-11-26, before and after this week's fixes to
SAP GUI scripting and the network reader (DIAG). 37 process scenarios;
DIAG ran only the scenarios it supports (26 on ECC, 12 on S/4HANA). Our
own surfaces only: no other method is in this table.

All scenarios each surface ran:

| Surface | System | Scenarios | Runs / scenario | Runs | Passed | Success | $ / run | $ / success | Tokens / run | Seconds / run | Steps / run | Date |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web GUI (Chrome) | ECC | 37 | 2 | 74 | 67 | 91% | $0.0052 | $0.0058 | 183k | 22 | 9.1 | 2026-11-25 |
| SAP GUI scripting, before fixes | ECC | 37 | 1 | 37 | 33 | 89% | $0.0053 | $0.0060 | 177k | 37 | 8.0 | 2026-11-25 |
| SAP GUI scripting | ECC | 37 | 2 | 74 | 67 | 91% | $0.0044 | $0.0048 | 141k | 22 | 6.8 | 2026-11-25 |
| DIAG (experimental), before fixes | ECC | 25 | 1 | 25 | 15 | 60% | $0.0075 | $0.0125 | 306k | 37 | 13.5 | 2026-11-25 |
| DIAG (experimental) | ECC | 26 | 1 | 26 | 23 | 88% | $0.0077 | $0.0087 | 282k | 36 | 11.8 | 2026-11-26 |
| Web GUI (Chrome) | S/4HANA | 37 | 2 | 74 | 66 | 89% | $0.0059 | $0.0066 | 224k | 30 | 10.2 | 2026-11-25 |
| SAP GUI scripting, before fixes | S/4HANA | 37 | 1 | 37 | 31 | 84% | $0.0057 | $0.0068 | 192k | 34 | 8.4 | 2026-11-25 |
| SAP GUI scripting | S/4HANA | 37 | 1 | 37 | 32 | 86% | $0.0052 | $0.0060 | 174k | 26 | 8.1 | 2026-11-25 |
| DIAG (experimental), before fixes | S/4HANA | 11 | 1 | 11 | 7 | 64% | $0.0065 | $0.0101 | 229k | 33 | 11.3 | 2026-11-26 |
| DIAG (experimental) | S/4HANA | 12 | 1 | 12 | 11 | 92% | $0.0056 | $0.0062 | 183k | 30 | 9.8 | 2026-11-26 |

Like for like on the scenarios DIAG supports, after the fixes:

| Surface | System | Scenarios | Runs | Passed | Success | $ / run | $ / success | Tokens / run | Seconds / run | Steps / run |
|---|---|---|---|---|---|---|---|---|---|---|
| Web GUI (Chrome) | ECC | 26 | 52 | 47 | 90% | $0.0053 | $0.0059 | 185k | 21 | 8.9 |
| SAP GUI scripting | ECC | 26 | 52 | 47 | 90% | $0.0044 | $0.0049 | 138k | 22 | 6.8 |
| DIAG (experimental) | ECC | 26 | 26 | 23 | 88% | $0.0077 | $0.0087 | 282k | 36 | 11.8 |
| Web GUI (Chrome) | S/4HANA | 12 | 24 | 23 | 96% | $0.0038 | $0.0039 | 100k | 20 | 6.5 |
| SAP GUI scripting | S/4HANA | 12 | 12 | 11 | 92% | $0.0037 | $0.0041 | 99k | 19 | 6.3 |
| DIAG (experimental) | S/4HANA | 12 | 12 | 11 | 92% | $0.0056 | $0.0062 | 183k | 30 | 9.8 |

Scenarios that failed in more than one row of the first table (after
the fixes for scripting and DIAG):

- SAFE-01, a safety scenario, failed in every run except one of the two
  Web GUI runs on S/4HANA. Its cause is not covered on this page.
- MD-01 failed on ECC in scripting (2 of 2), in DIAG, and once in Web GUI.
- FIN-04 failed in Web GUI on ECC and in scripting on both systems.
- P2P-07 failed in Web GUI on ECC (2 of 2) and on S/4HANA (1 of 2), and
  in scripting on S/4HANA.
- P2P-08 failed in scripting on both systems (1 of 2 on ECC) and in DIAG
  on ECC.
- REP-01 failed on S/4HANA in Web GUI (2 of 2) and in scripting.

## 4. Six long ECC scenarios, three models

Run of 2026-11-26. Scenarios O2C-01, O2C-06, P2P-01, MD-04, REP-03 and
REP-07 on ECC, procedure mode, about two runs per scenario (10 to 14
valid runs per cell, except 3 for computer use with Opus on SAP GUI). Figures are copied from the harness's comparison
report. Each cell: passed / runs, success, $ per run.

| Method | Surface | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|---|
| sap-ui-automation MCP | Web GUI | 12/12 100%, $0.0097 | 12/12 100%, $0.1073 | 12/12 100%, $0.2409 |
| sap-ui-automation MCP | SAP GUI scripting | 12/12 100%, $0.0097 | 10/10 100%, $0.1031 | 10/10 100%, $0.2058 |
| sap-ui-automation MCP | DIAG (experimental, before the 2026-11-26 fixes) | 4/12 33%, $0.0184 | 8/12 67%, $0.2158 | 8/12 67%, $0.5884 |
| sap-ui-automation CLI | Web GUI | 11/13 85%, $0.0169 | 12/12 100%, $0.1174 | 12/12 100%, $0.2787 |
| Playwright MCP | Web GUI | 11/11 100%, $0.0763 | 11/12 92%, $0.3799 | 12/12 100%, $0.6241 |
| Chrome DevTools MCP | Web GUI | 9/11 82%, $0.3754 | 12/12 100%, $0.6314 | 12/12 100%, $1.16 |
| Claude computer use | SAP GUI desktop | 11/14 79%, $0.0214 | 10/10 100%, $0.2182 | 3/3 100%, $0.3606 |
| Claude computer use | Web GUI in a browser tab | 10/12 83%, $0.0199 | 11/13 85%, $0.1895 | 12/12 100%, $0.3921 |
| Claude browser use | Web GUI | 10/11 91%, $0.2115 | 12/12 100%, $0.4581 | 12/12 100%, $0.9585 |

Seconds per run (Haiku / Sonnet / Opus):

| Method | Seconds per run |
|---|---|
| sap-ui-automation MCP, Web GUI | 43 / 46 / 49 |
| sap-ui-automation MCP, SAP GUI scripting | 44 / 33 / 45 |
| Playwright MCP | 231 / 181 / 178 |
| Chrome DevTools MCP | 207 / 165 / 161 |
| Claude computer use, SAP GUI | 249 / 192 / 168 |
| Claude browser use | 332 / 227 / 258 |

One more model: sap-ui-automation MCP with Claude Fable 5.2
(`claude-fable-5-2`) on Web GUI passed 12 of 12, at $0.4085 and 56
seconds per run.

The DIAG rows of this table ran before the DIAG fixes of the same
afternoon, so they are lower than DIAG in table 3.

## Caveats

- **Small samples.** Tables 1 to 3 use one model. The pilot (tables 1 and
  2) is one run per scenario per system. In table 3, Web GUI and ECC
  scripting are two runs per scenario; DIAG and S/4HANA scripting are
  one. Table 4 is about two runs per scenario on six scenarios.
- **Success rates are close to noise.** At about 104 runs and 88% success
  the 95% interval is roughly ±6 points; at 30 runs it is about ±11
  points; at 12 runs it spans tens of points. In table 1, Claude computer
  use (90%), Playwright MCP and Chrome DevTools MCP (88%) are not worse
  than the sap-ui-automation MCP (89%). The differences in cost, tokens
  and time are the robust result, not the success ranking.
- **Cost sources differ.** Methods run in Claude Code include Claude
  Code's own system prompt and tool definitions in their cost. Computer
  use and browser use are priced at list prices in the harness's own
  loop, and started every run with a cold prompt cache.
- **Steps do not compare one to one.** A computer-use or browser-use step
  is one screenshot, click or keystroke; an MCP step is one tool call that
  may do more.
- **"Long" is our definition.** The long-scenario set was chosen by our
  own MCP's step count (10 or more on ECC), not by a neutral party.
- **Fixes fitted to the same scenarios.** The "after fixes" rows for
  scripting and DIAG in table 3 are the last round of fixes made on these
  same scenarios, so they can be fitted to them. Held-out scenarios were
  not run. The Web GUI rows are the baseline run of the same day, with no
  Web GUI fixes in between.
- **Version.** The result rows do not record the package version. These
  runs used the development branch during the 0.5.0 work, not a tagged
  release.
- **DIAG is experimental.**
- **Two lab systems.** One ECC and one S/4HANA, with our own test data.
  Results on other systems and customizing may differ.

## Not in these results

- Other open-source SAP GUI MCP servers: no comparison with them is
  published.
- Fiori and single-step tasks: the pilot ran some; they are not analysed
  on this page yet.
- Runs where the agent gets the instruction without a step-by-step
  procedure.
- Models from other providers, and more than one model in tables 1 to 3.
- Held-out scenarios, other SAP systems, and samples large enough to rank
  success rates.
- The harness and the raw results: not public yet.
