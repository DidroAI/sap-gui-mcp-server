/**
 * A `*.sap.ts` test: the recording written with the scripting API (src/sdk),
 * run by `sap-gui-mcp-server/test`.
 *
 *   steps      one SDK line each (sdk/code.ts `codeOf`)
 *   variables  `const vars = {...}` with the recorded values; written
 *              `${vars.order}` where they were typed or expected
 *   captures   `const order = ...` read from the status bar, a field or the
 *              title, with the recorded pattern; later steps use `${order}`
 *   checks     `await expect(...)`: they wait, as a replay's checks do not
 *   notes      comments
 *
 * A step that confirmed a popup that only informs (`on.message`) is run only
 * when that popup is there: a replay skips it when SAP does not show it
 * again, and so does the test.
 *
 * Not written: the checks a replay makes on its own after every step (no
 * error in the status bar, the recorded screen). The test checks what the
 * recording marked, as a hand-written test would.
 */
import type { NormalizedAction } from "../../core/action.js";
import { codeOf, draftTest } from "../../sdk/code.js";
import type { Capture, Check, SapTest, Step } from "../format.js";
import { inputsOf } from "../format.js";
import { exportTidy } from "./sap-ts-tidy.js";

const q = (v: unknown) => JSON.stringify(v);
export const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const HOME = new Set(["SESSION_MANAGER", "SMEN", "S000"]);
/** Names a capture cannot be a `const` under: the test's own names and the words of the language. */
export const TAKEN = new Set(
  "sap vars expect test await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield async undefined arguments eval".split(" "),
);

/** How the test refers to each variable: `vars.order`, or `order` for a value a step captures. */
export type Refs = Map<string, string>;

/** A string as TypeScript: a plain literal, a variable alone, or a template literal for text with variables in it. */
export function str(text: string, refs: Refs): string {
  const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  if (whole && refs.has(whole[1] as string)) return refs.get(whole[1] as string) as string;
  let used = false;
  const body = text
    .replace(/[`\\]/g, "\\$&")
    .replace(/\$\{/g, "\\${")
    .replace(/\\\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
      const ref = refs.get(name);
      if (!ref) return m;
      used = true;
      return `\${${ref}}`;
    });
  return used ? `\`${body}\`` : q(text);
}

/** The string literals of a line with variables in them, rewritten: `"${order}"` -> `order`. */
export function withRefs(line: string, refs: Refs): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, (lit) => {
    const s = JSON.parse(lit) as string;
    VAR.lastIndex = 0;
    return VAR.test(s) ? str(s, refs) : lit;
  });
}

/** A regular expression as TypeScript: a literal, or `new RegExp(...)` when it holds variables or line breaks. */
export function regex(pattern: string, refs: Refs): string {
  VAR.lastIndex = 0;
  if (VAR.test(pattern) || /[\n\r\u2028\u2029]/.test(pattern) || !pattern) return `new RegExp(${str(pattern, refs)})`;
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      out += c + (pattern[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    out += c === "/" && !inClass ? "\\/" : c;
  }
  return `/${out}/`;
}

/** How many groups a pattern has (0 when it is not a regular expression). */
export function groups(pattern: string): number {
  try {
    return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return 0;
  }
}

/** The expression that reads what a check or capture is about, as a string. */
export function reading(c: { check?: string; from?: string; id?: string | undefined }): string {
  const what = c.check ?? c.from;
  if (what === "status") return "await sap.status().text()";
  if (what === "field") return `await sap.field(${q(c.id ?? "")}).value()`;
  if (what === "title") return '(await sap.screen()).title ?? ""';
  if (what === "transaction") return '(await sap.screen()).transaction ?? ""';
  return "(await sap.screen()).text";
}

/** One check as an `expect` line. */
export function checkLine(c: Check, refs: Refs): string {
  const v = c.op === "matches" ? regex(c.value, refs) : str(c.value, refs);
  // A "contains" on the title or the transaction has no matcher of its own: an escaped regular expression.
  const part = () => regex(c.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\\\$\\\{([A-Za-z_][A-Za-z0-9_]*)\\\}/g, "${$1}"), refs);
  switch (c.check) {
    case "status":
      return `await expect(sap.status()).${c.op === "contains" ? "toContainText" : "toHaveText"}(${v});`;
    case "field":
      return `await expect(sap.field(${q(c.id ?? "")})).${c.op === "contains" ? "toContainValue" : "toHaveValue"}(${v});`;
    case "title":
      return `await expect(sap).toHaveTitle(${c.op === "contains" ? part() : v});`;
    case "transaction":
      return c.op === "equals" ? `await expect(sap).toHaveTransaction(${v});` : `expect(${reading(c)}).toMatch(${c.op === "contains" ? part() : v});`;
    default:
      return `await expect(sap).toContainText(${v});`;
  }
}

/** A capture: the line that reads it and, with a pattern, the one that makes sure it was found. */
function captureLines(c: Capture, refs: Refs, local: Set<string>): string[] {
  const target = local.has(c.var) ? `const ${c.var}` : (refs.get(c.var) as string);
  if (!c.pattern) {
    const read = c.from === "field" ? reading(c) : `(${reading(c)}).trim()`;
    return [`${target} = ${read};`];
  }
  const g = groups(c.pattern) > 0 ? 1 : 0;
  const name = local.has(c.var) ? c.var : (refs.get(c.var) as string);
  return [`${target} = ${regex(c.pattern, refs)}.exec(${reading(c)})?.[${g}] ?? "";`, `expect(${name}).toBeTruthy();`];
}

/** The SDK line(s) of a step's action, guarded when it confirms a popup SAP may not show again. */
function actionLines(s: Step, refs: Refs): string[] {
  if (!s.action) return [];
  const line = withRefs(codeOf(s.action as NormalizedAction), refs);
  if (!s.on?.message || !s.on.popup) return [line];
  const id = typeof s.action.id === "string" ? s.action.id : "";
  const there = id.startsWith(`${s.on.popup}/`) ? `await sap.control(${q(id)}).exists()` : `(await sap.screen()).windows.some((w) => w.id === ${q(s.on.popup)})`;
  return [`// a popup that only informs${s.on.title ? ` ("${s.on.title}")` : ""}: SAP may not show it again`, `if (${there}) ${line}`];
}

export const comment = (text: string) => text.split(/\r?\n/).map((l) => `// ${l}`.trimEnd());

export interface SapTsOptions {
  /** Where the test imports from; default the package's test entry. */
  from?: string;
  /** Tidy the recording first (record/tidy.ts) and write it as a person would: see `exportTidy`. */
  tidy?: boolean;
}

/** The recording as a `*.sap.ts` test. */
export function exportSapTs(test: SapTest, options: SapTsOptions = {}): string {
  if (options.tidy) return exportTidy(test, options).text;
  const inputs = new Set(inputsOf(test));
  const times = new Map<string, number>();
  for (const s of test.steps) for (const c of s.capture ?? []) times.set(c.var, (times.get(c.var) ?? 0) + 1);
  // A value captured once, not given from outside, under a free name: a `const` at the step that reads it.
  const local = new Set([...times].filter(([v, n]) => n === 1 && !inputs.has(v) && !TAKEN.has(v)).map(([v]) => v));
  const refs: Refs = new Map();
  const kept = Object.entries(test.variables).filter(([k]) => !local.has(k));
  for (const [k] of kept) refs.set(k, `vars.${k}`);

  const lines: string[] = [];
  if (kept.length) lines.push("const vars = {", ...kept.flatMap(([k, v]) => [...(v.description ? comment(v.description).map((l) => `  ${l}`) : []), `  ${k}: ${q(v.value)},`]), "};");
  // A replay opens the start transaction fresh when the recording does not begin with an okcode: so does the test.
  const first = test.steps[0]?.action;
  const t = test.start.transaction;
  if (!(first?.do === "okcode" && /^\/n\S/i.test(String(first.value ?? ""))) && t && !HOME.has(t.toUpperCase()) && test.recorded.surface !== "fiori")
    lines.push(`await sap.okcode(${q(`/n${t}`)}); // the recording started in ${t}`);
  for (const s of test.steps) {
    if (s.note) lines.push(...comment(s.note));
    lines.push(...actionLines(s, refs));
    // Captures first, as a replay does: a check on the same step may use what was captured.
    for (const c of s.capture ?? []) {
      lines.push(...captureLines(c, refs, local));
      if (local.has(c.var)) refs.set(c.var, c.var);
    }
    for (const c of s.expect ?? []) lines.push(checkLine(c, refs));
  }

  const r = test.recorded;
  const where = `${r.surface}${r.method ? ` (${r.method})` : ""}${r.system ? ` ${r.system}${r.client ? `/${r.client}` : ""}` : ""}`;
  const head = [`// Recorded on ${where}${r.at ? `, ${r.at.slice(0, 10)}` : ""}.`, ...(test.description ? comment(test.description) : [])];
  return `${head.join("\n")}\n${draftTest({ name: test.name, lines, ...(options.from ? { from: options.from } : {}) })}`;
}
