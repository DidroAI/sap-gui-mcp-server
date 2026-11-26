---
title: "Trace viewer for SAP tests and agent runs"
description: "See what an agent or a test did in SAP, step by step, with timings, screens and screenshots."
---

# Trace viewer

A trace is a recording with timings, screens and screenshots: what the
agent or the test did, step by step, and what SAP showed after each step.
Use it to see why a test failed, or to review what an agent did before you
trust it with more.

## Making a trace

- **Tests:** the [test runner](sdk-tests.md#the-test-runner) writes a trace
  for each test to `sap-results/<test>/`.
- **Scripts:** `connect({ trace: { dir, name, screenshots: true } })`; `sap.close()`
  returns the trace's path.
- **Agents:** `sap_record` with `SAP_RECORD_DIR` ([Recording and
  replay](record-replay.md)).

A trace is a `.saptest.json` file (format `sap-gui-test/1`), the same as a
recording. Each step can carry:

| Field | Holds |
| --- | --- |
| `ms` | how long the step took |
| `at` | when it started (ISO time) |
| `screen` | the compact screen after the step |
| `code` | the SDK line that repeats it |
| `shot` | the path of a screenshot, `<name>.trace/step-N.png` |

## Opening it

```sh
npx sap-ui-automation show-trace sap-results/order-4711/trace.saptest.json --open
```

`show-trace` writes one self-contained HTML file next to the JSON (or to
`--out <file>`) and, with `--open`, opens it in your browser. The page has
no scripts or fonts from the network: you can attach it to a ticket or keep
it with test results.

::: danger Traces hold business data
Screens, screenshots and typed values are in the trace. Treat a trace like
the system's data: keep it where that data may be kept, and do not attach
it to public issues. See [Security and data handling](../security.md).
:::
