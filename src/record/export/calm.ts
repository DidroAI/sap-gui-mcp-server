/**
 * SAP Cloud ALM manual test case.
 *
 * The output is the input of a `calm_create_test_case` tool, as a Cloud ALM
 * MCP server offers it: a title and activities, each with steps (title,
 * description, expected result, evidence). That tool turns it into the body
 * of `POST calm-testmanagement/v1/ManualTestCases` (toActivities, toActions)
 * and adds the project and scope. Nothing here calls Cloud ALM.
 *
 * One activity per screen the test works on, in order; one step per action.
 */
import type { SapTest, Step } from "../format.js";
import { doing, expected, human, surfaceName, systemOf } from "./words.js";

export interface CalmStep {
  title: string;
  description: string;
  expected: string;
  evidence?: boolean;
}
export interface CalmTestCase {
  title: string;
  priority?: 10 | 20 | 30 | 40;
  activities: { title: string; steps: CalmStep[] }[];
}

/** The limits of calm_create_test_case. */
const MAX = { title: 250, stepTitle: 500, text: 4000, steps: 50, activities: 30 };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The screen a step belongs to: where it is done. Opening a transaction belongs to the screen it opens, not to wherever the session was. */
const screenOf = (s: Step) => (s.action?.do === "okcode" && /^\/[nNoO*]\S/.test(String(s.action.value ?? "")) ? (s.after ?? s.on) : s.on);
const screenKey = (s: Step) => `${screenOf(s)?.transaction ?? ""}|${screenOf(s)?.program ?? ""}|${screenOf(s)?.screen ?? ""}`;
const screenTitle = (s: Step) => [screenOf(s)?.transaction, screenOf(s)?.title].filter(Boolean).join(": ") || "Screen";

export function toCalm(test: SapTest): CalmTestCase {
  const activities: CalmTestCase["activities"] = [];
  const vars = Object.entries(test.variables);
  activities.push({
    title: "Preparation",
    steps: [
      {
        title: `Log on to ${systemOf(test)}`,
        description: `Log on to ${systemOf(test)} with ${surfaceName(test)}.${vars.length ? `\nTest data:\n${vars.map(([k, v]) => `- <${k}> = ${v.value}${v.description ? ` (${v.description})` : ""}`).join("\n")}` : ""}`,
        expected: "You are logged on and see the SAP start screen.",
      },
    ],
  });
  let key: string | undefined;
  for (const s of test.steps) {
    const k = screenKey(s);
    let current = activities.at(-1);
    if (k !== key || !current || current.steps.length >= MAX.steps) {
      current = { title: cut(human(screenTitle(s)), MAX.title), steps: [] };
      activities.push(current);
      key = k;
    }
    const what = human(doing(s));
    const exp = expected(s).map(human);
    current.steps.push({
      title: cut(what, MAX.stepTitle),
      description: cut([s.note ? human(s.note) : undefined, `${what}.`, s.action?.id ? `Control: ${String(s.target?.id ?? s.action.id)}` : undefined].filter(Boolean).join("\n"), MAX.text),
      expected: cut(exp.length ? exp.map((e) => `${e}.`).join("\n") : "The step runs without an error message.", MAX.text),
      // Proof is asked where the test checks something, and where it writes.
      ...((s.expect?.length ?? 0) > 0 || s.risk === "commit" ? { evidence: true } : {}),
    });
  }
  if (activities.length > MAX.activities) throw new Error(`the test works on ${activities.length - 1} screens; a Cloud ALM test case built by calm_create_test_case holds at most ${MAX.activities} activities. Split the recording.`);
  return { title: cut(test.name, MAX.title), activities };
}

export function exportCalm(test: SapTest): string {
  return `${JSON.stringify({ tool: "calm_create_test_case", arguments: toCalm(test) }, null, 2)}\n`;
}
