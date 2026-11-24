/**
 * `sap-ui-automation/test`: what `*.sap.ts` files import, and the runner as
 * a library.
 *
 *   import { expect, test } from "sap-ui-automation/test";
 *   test("display an order", async ({ sap }) => { ... });
 */
export { expect, ExpectError, type ExpectOptions } from "../sdk/expect.js";
export { type Fixtures, type HookFn, type TestDetails, type TestFn, type TestInfo, test } from "./collect.js";
export { configFor, defineConfig, findConfig, loadConfig, type ProjectConfig, type ReporterName, type ReporterOptions, type ReporterSpec, type ResolvedConfig, resolveConfig, type SapConfig, type UseOptions } from "./config.js";
export { driftLines, htmlReport, jsonReport, junitReport, listLine, listSummary, type Reporter, reporters, type TraceHtml } from "./reporters.js";
export { type Attempt, findTestFiles, type LockReport, lockKey, type RunOptions, type RunResult, runTests, type Status, type TestResult } from "./run.js";
export { testCommand } from "./cli.js";
