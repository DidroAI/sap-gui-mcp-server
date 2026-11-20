/** The export targets of a recorded test. Each is a pure function from the test to a file's text. */
import type { SapTest } from "../format.js";
import { exportCalm } from "./calm.js";
import { exportGherkin } from "./gherkin.js";
import { exportPlaywright } from "./playwright.js";
import { exportSapTs } from "./sap-ts.js";
import { exportVbs } from "./vbs.js";

export const TARGETS = {
  calm: { suffix: ".calm.json", what: "SAP Cloud ALM manual test case, as the input of a Cloud ALM MCP server's calm_create_test_case tool", run: exportCalm },
  vbs: { suffix: ".vbs", what: "SAP GUI scripting (VBScript), for SAP GUI for Windows", run: exportVbs },
  playwright: { suffix: ".spec.ts", what: "Playwright test for Web GUI (@playwright/test)", run: (t: SapTest) => exportPlaywright(t) },
  "playwright-sap": { suffix: ".psap.spec.ts", what: "Playwright test with playwright-sap's locateSID", run: (t: SapTest) => exportPlaywright(t, { flavor: "playwright-sap" }) },
  "sap-ts": { suffix: ".sap.ts", what: "test for this package's own runner (sap-gui-mcp-server/test), written with its scripting API", run: (t: SapTest) => exportSapTs(t) },
  gherkin: { suffix: ".feature", what: "Gherkin feature (Given / When / Then step list)", run: exportGherkin },
} as const;

export type Target = keyof typeof TARGETS;
export const TARGET_NAMES = Object.keys(TARGETS) as Target[];

export function exportTest(test: SapTest, to: string): { text: string; suffix: string } {
  const target = TARGETS[to as Target];
  if (!target) throw new Error(`Unknown export target "${to}". Use one of: ${TARGET_NAMES.join(", ")}.`);
  return { text: target.run(test), suffix: target.suffix };
}

export { exportCalm, toCalm } from "./calm.js";
export { exportGherkin } from "./gherkin.js";
export { exportPlaywright } from "./playwright.js";
export { exportSapTs } from "./sap-ts.js";
export { exportVbs } from "./vbs.js";
