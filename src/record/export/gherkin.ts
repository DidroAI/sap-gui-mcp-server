/** A Gherkin feature: the step list in Given / When / Then, for Cucumber-style tools and for reading. */
import type { SapTest } from "../format.js";
import { doing, expected, human, surfaceName, systemOf } from "./words.js";

export function exportGherkin(test: SapTest): string {
  const out = [`Feature: ${test.name}`];
  if (test.description) out.push(`  ${test.description}`);
  out.push("", `  Scenario${Object.keys(test.variables).length ? " Outline" : ""}: ${test.name}`, `    Given I am logged on to ${systemOf(test)} with ${surfaceName(test)}`);
  let last = "Given";
  const say = (kind: "When" | "Then", text: string) => {
    out.push(`    ${kind === last ? "And" : kind} ${text}`);
    last = kind;
  };
  for (const s of test.steps) {
    if (s.action) say("When", `I ${lower(human(doing(s)))}`);
    for (const e of expected(s)) say("Then", lower(human(e)));
  }
  const vars = Object.entries(test.variables);
  if (vars.length) {
    out.push("", "    Examples:", `      | ${vars.map(([k]) => k).join(" | ")} |`, `      | ${vars.map(([, v]) => v.value).join(" | ")} |`);
  }
  return `${out.join("\n")}\n`;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
