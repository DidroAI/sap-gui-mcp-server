/**
 * The SDK line that repeats an action: what `sap_act` answers with (so an
 * agent's run turns into a script as it goes), what the recorder keeps, and
 * what codegen writes into a `*.sap.ts` test.
 *
 *   {"do":"okcode","value":"/nVA03"}        await sap.okcode("/nVA03");
 *   {"do":"set","id":"ctxtVBAK-VBELN",...}  await sap.set("ctxtVBAK-VBELN", "4711");
 *   {"do":"key","key":0}                    await sap.key(0);
 *
 * Every line is valid TypeScript against `Sap` (src/sdk/session.ts). An
 * action the shorthands do not cover is written as `sap.act({...})`, which
 * takes any action `sap_act` takes.
 */
import type { Action } from "../core/types.js";

const q = (v: unknown): string => JSON.stringify(v);

/** The keys of an action other than `do` and the ones a shorthand already wrote. */
function rest(a: Action, used: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (k !== "do" && !used.includes(k) && v !== undefined) out[k] = v;
  return out;
}

/** An options argument when there are extra keys: `, {"how":"double"}`. */
function opts(a: Action, used: string[]): string {
  const r = rest(a, used);
  return Object.keys(r).length ? `, ${q(r)}` : "";
}

/** The expression (without `await` and `;`) on `sap` that runs this action. */
export function callOf(a: Action, on = "sap"): string {
  const id = typeof a.id === "string" ? a.id : undefined;
  const generic = () => `${on}.act(${q(a)})`;
  switch (a.do) {
    case "okcode":
      return typeof a.value === "string" && Object.keys(rest(a, ["value"])).length === 0 ? `${on}.okcode(${q(a.value)})` : generic();
    case "set":
      if (!id || a.value === undefined) return generic();
      return `${on}.set(${q(id)}, ${q(a.value)}${opts(a, ["id", "value"])})`;
    case "press":
    case "click":
    case "f4":
    case "dblclick":
    case "focus":
      if (!id) return generic();
      return `${on}.${a.do}(${q(id)}${opts(a, ["id"])})`;
    case "key":
      return a.key === undefined || Object.keys(rest(a, ["key"])).length ? generic() : `${on}.key(${q(a.key)})`;
    case "select":
      if (!id) return generic();
      return `${on}.select(${q(id)}${opts(a, ["id"])})`;
    case "check":
      if (!id) return generic();
      return a.value === false ? `${on}.check(${q(id)}, false${opts(a, ["id", "value"])})` : `${on}.check(${q(id)}${opts(a, ["id", "value"])})`;
    case "combo":
      if (!id || a.key === undefined) return generic();
      return `${on}.combo(${q(id)}, ${q(a.key)}${opts(a, ["id", "key"])})`;
    case "open":
      return typeof a.app === "string" && Object.keys(rest(a, ["app"])).length === 0 ? `${on}.open(${q(a.app)})` : generic();
    case "scroll":
      if (!id || a.to === undefined) return generic();
      return `${on}.scroll(${q(id)}, ${q(a.to)}${opts(a, ["id", "to"])})`;
    default:
      return generic();
  }
}

/** One statement: `await sap.okcode("/nVA03");`. */
export function codeOf(a: Action, on = "sap"): string {
  return `await ${callOf(a, on)};`;
}

/** A quoted string for a test's name. */
const title = (s: string) => q(s);

export interface DraftOptions {
  /** The test's name. */
  name: string;
  /** Statements, one per line, already indented or not. */
  lines: string[];
  /** Where the test imports the runner from; default the package's test entry. */
  from?: string;
}

/** A whole `*.sap.ts` file with one test made of these lines. */
export function draftTest({ name, lines, from = "sap-gui-mcp-server/test" }: DraftOptions): string {
  const body = lines.map((l) => (l ? `  ${l}` : "")).join("\n");
  return `import { expect, test } from ${q(from)};\n\ntest(${title(name)}, async ({ sap }) => {\n${body}\n});\n`;
}
