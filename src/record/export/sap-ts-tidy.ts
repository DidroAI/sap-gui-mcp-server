/**
 * A recording tidied (record/tidy.ts) as the `*.sap.ts` test a person would write:
 *   - one `sap.step` block per screen, named by its title;
 *   - short ids; numbered buttons (btn[0]) pressed by their label;
 *   - key names (Enter, F8) instead of numbers; key 11 as `sap.save()`;
 *   - what SAP shows for some data only, as conditions: an information
 *     popup (`sap.dismissInfo()`), a screen of replay.ts OPTIONAL_SCREENS
 *     answered with its neutral button (`if (await sap.at(...))`), a warning
 *     after a save acknowledged with Enter (`sap.save({ acceptWarnings: true })`);
 *   - captures from the status bar as `await expect(sap.status()).capture(re)`;
 *   - the checks tidy added from what the recording saw, and its TODO list
 *     as a comment at the top.
 */
import type { NormalizedAction } from "../../core/action.js";
import { numberedSegment } from "../../core/ids.js";
import { vkeyNumber } from "../../sapgui/keys.js";
import { codeOf, draftTest } from "../../sdk/code.js";
import { bareLabel } from "../../sdk/locators.js";
import { type Capture, inputsOf, type SapTest, type Step } from "../format.js";
import { acknowledgesWarning, confirmsInfo, isSave, optionalScreen, tidy, type TidyResult } from "../tidy.js";
import { checkLine, comment, groups, HOME, reading, type Refs, regex, str, TAKEN, withRefs } from "./sap-ts.js";

const q = (v: unknown) => JSON.stringify(v);

/** A virtual key as the name code reads ("Enter", "F8", "Control+S"); the number when it has none. */
export function keyName(key: unknown): string | number | undefined {
  if (typeof key === "string") return key;
  if (typeof key !== "number") return undefined;
  const fixed: Record<number, string> = { 0: "Enter", 3: "Back", 11: "Control+S", 12: "Escape" };
  const name =
    fixed[key] ??
    (key >= 1 && key <= 12 ? `F${key}` : key > 12 && key <= 24 ? `Shift+F${key - 12}` : key > 24 && key <= 36 ? `Control+F${key - 24}` : key > 36 && key <= 48 ? `Control+Shift+F${key - 36}` : undefined);
  return name !== undefined && vkeyNumber(name) === key ? name : key;
}

const numbered = (id: string) => numberedSegment(id.slice(id.lastIndexOf("/") + 1));
const indent = (lines: string[]) => lines.map((l) => (l ? `  ${l}` : l));
const opens = (s: Step) => s.action?.do === "okcode" && /^\/n\S/i.test(String(s.action.value ?? ""));
const same = (a: Step["on"], b: Step["on"]) => !!a && !!b && a.program === b.program && a.screen === b.screen && a.transaction === b.transaction;

export interface TidyExport extends TidyResult {
  /** The `*.sap.ts` file. */
  text: string;
}

export function exportTidy(original: SapTest, options: { from?: string } = {}): TidyExport {
  const tidied = tidy(original);
  const test = tidied.test;
  const steps = test.steps;
  const inputs = new Set(inputsOf(test));
  const times = new Map<string, number>();
  for (const s of steps) for (const c of s.capture ?? []) times.set(c.var, (times.get(c.var) ?? 0) + 1);
  // A value captured once, not given from outside, under a free name: a `const`.
  const local = new Set([...times].filter(([v, n]) => n === 1 && !inputs.has(v) && !TAKEN.has(v)).map(([v]) => v));
  const refs: Refs = new Map();
  const kept = Object.entries(test.variables).filter(([k]) => !local.has(k));
  for (const [k] of kept) refs.set(k, `vars.${k}`);

  const lines: string[] = [];
  if (kept.length) lines.push("const vars = {", ...kept.map(([k, v]) => `  ${k}: ${q(v.value)},`), "};");
  const first = steps[0];
  const t = test.start.transaction;
  if (!(first && opens(first)) && t && !HOME.has(t.toUpperCase()) && test.recorded.surface !== "fiori") lines.push(`await sap.okcode(${q(`/n${t}`)}); // the recording started in ${t}`);

  // Blocks: the steps done on one screen. A popup, a screen SAP shows for some data only and the
  // Enter that acknowledges a save's warning stay in the block they interrupt.
  const blocks: { name: string; at: Step["on"]; steps: number[] }[] = [];
  steps.forEach((s, i) => {
    const cur = blocks.at(-1);
    const joins = !!s.on?.popup || !!optionalScreen(s.on) || acknowledgesWarning(steps[i - 1], s);
    if (opens(s) || !cur || (!joins && !same(cur.at, s.on))) {
      const at = opens(s) ? s.after : s.on;
      blocks.push({ name: at?.title || at?.transaction || `step ${i + 1}`, at, steps: [i] });
    } else cur.steps.push(i);
  });

  const captureLine = (c: Capture, target: string, name: string): string[] => {
    if (c.from === "status" && c.pattern) return [`${target} = await expect(sap.status()).capture(${regex(c.pattern, refs)});`];
    if (!c.pattern) return [`${target} = ${c.from === "field" ? reading(c) : `(${reading(c)}).trim()`};`];
    return [`${target} = ${regex(c.pattern, refs)}.exec(${reading(c)})?.[${groups(c.pattern) > 0 ? 1 : 0}] ?? "";`, `expect(${name}).toBeTruthy();`];
  };

  /** The lines of step `i`; returns how many steps they cover (2 for a save and the Enter that acknowledged its warning). */
  const stepLines = (i: number, out: string[], returned: string | undefined): number => {
    const s = steps[i] as Step;
    const a = s.action;
    if (s.note) out.push(...comment(s.note));
    let used = 1;
    const label = bareLabel(s.target?.label ?? "");
    const o = optionalScreen(s.on);
    if (!a) {
      // a step that only checks
    } else if (isSave(s) && steps[i + 1] && acknowledgesWarning(s, steps[i + 1] as Step)) {
      out.push(`await sap.save({ acceptWarnings: true }); // SAP may answer with a warning first ("${s.after?.status?.text ?? ""}"): Enter acknowledges it`);
      used = 2;
    } else if (isSave(s) && a.do === "key") out.push("await sap.save();");
    else if (confirmsInfo(s)) out.push(`await sap.dismissInfo(); // the popup "${s.on?.title ?? ""}" only informs; SAP shows it for some data only`);
    else if (o && a.do === "press" && o.button.test(s.target?.label ?? "") && s.on?.program)
      out.push(`if (await sap.at(${q(`${s.on.program}${s.on.screen ? `/${s.on.screen}` : ""}`)})) await sap.button(${q(label)}).press(); // ${o.what}: SAP shows it for some data only`);
    else if (a.do === "press" && typeof a.id === "string" && numbered(a.id) && label) out.push(`await sap.button(${q(label)}).press();`);
    else if (a.do === "key" && Object.keys(a).every((k) => k === "do" || k === "key")) out.push(`await sap.key(${q(keyName(a.key))});`);
    else out.push(withRefs(codeOf(a as NormalizedAction), refs));
    for (const x of steps.slice(i, i + used)) {
      // Captures first, as a replay reads them: a check of the same step may use one.
      for (const c of x.capture ?? []) {
        if (local.has(c.var)) {
          out.push(...captureLine(c, c.var === returned ? `const ${c.var}` : c.var, c.var));
          refs.set(c.var, c.var);
        } else out.push(...captureLine(c, refs.get(c.var) as string, refs.get(c.var) as string));
      }
      for (const c of x.expect ?? []) out.push(checkLine(c, refs));
    }
    return used;
  };

  for (const b of blocks) {
    const name = str(b.name, refs);
    const mine = b.steps.flatMap((i) => (steps[i]?.capture ?? []).map((c) => c.var)).filter((v) => local.has(v));
    const last = steps[b.steps.at(-1) as number];
    // One value the block makes, read at its end: the block returns it.
    const returned = mine.length === 1 && (last?.capture ?? []).some((c) => c.var === mine[0]) ? mine[0] : undefined;
    const body: string[] = [];
    for (let k = 0; k < b.steps.length; ) k += stepLines(b.steps[k] as number, body, returned);
    if (returned) lines.push(`const ${returned} = await sap.step(${name}, async () => {`, ...indent(body), `  return ${returned};`, "});");
    else {
      if (mine.length) lines.push(`let ${mine.map((v) => `${v} = ""`).join(", ")};`);
      lines.push(`await sap.step(${name}, async () => {`, ...indent(body), "});");
    }
  }

  const r = test.recorded;
  const where = `${r.surface}${r.method ? ` (${r.method})` : ""}${r.system ? ` ${r.system}${r.client ? `/${r.client}` : ""}` : ""}`;
  const head = [
    `// Recorded on ${where}${r.at ? `, ${r.at.slice(0, 10)}` : ""}; tidied from ${original.steps.length} recorded steps to ${steps.length}.`,
    ...(test.description ? comment(test.description) : []),
    ...(tidied.todo.length ? ["// TODO:", ...tidied.todo.flatMap((x) => comment(`  - ${x}`))] : []),
  ];
  const text = `${head.join("\n")}\n${draftTest({ name: test.name, lines, ...(options.from ? { from: options.from } : {}) })}`;
  return { ...tidied, text };
}
