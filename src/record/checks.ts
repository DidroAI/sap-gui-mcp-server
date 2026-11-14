/** Checks and captures, evaluated on a parsed screen. Used when a check is marked (it must hold then) and at replay. */
import { type Capture, type Check, fill } from "./format.js";
import { locate, type ParsedScreen } from "./screen.js";

export interface Verdict {
  ok: boolean;
  /** One line: what was expected and what is there. */
  text: string;
  /** The id the control was found under, when it is not the recorded one. */
  relocated?: string;
}

function subject(screen: ParsedScreen, c: { check?: string; from?: string; id?: string | undefined; label?: string | undefined; type?: string | undefined }): { name: string; actual?: string; relocated?: string } {
  const what = c.check ?? c.from;
  if (what === "status") return { name: "the status bar", actual: screen.status?.text ?? "" };
  if (what === "title") return { name: "the window title", actual: screen.title ?? "" };
  if (what === "transaction") return { name: "the transaction", actual: screen.transaction ?? "" };
  if (what === "text") return { name: "the screen", actual: screen.text };
  const id = c.id ?? "";
  const found = locate(screen, id);
  const name = `${c.label ? `"${c.label}" ` : ""}(${id})`;
  if (!found) return { name };
  return { name, actual: found.control.value, ...(found.by !== "exact" ? { relocated: found.control.id } : {}) };
}

const show = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

export function evaluate(screen: ParsedScreen, c: Check, vars: Record<string, string>): Verdict {
  const s = subject(screen, c);
  const expected = fill(c.value, vars);
  if (s.actual === undefined) return { ok: false, text: `${s.name} is not on the screen; expected it to ${c.op === "equals" ? "be" : c.op === "contains" ? "contain" : "match"} "${expected}"` };
  let ok: boolean;
  if (c.op === "equals") ok = s.actual.trim() === expected.trim();
  else if (c.op === "contains") ok = s.actual.includes(expected);
  else {
    try {
      ok = new RegExp(expected).test(s.actual);
    } catch (e) {
      return { ok: false, text: `"${expected}" is not a regular expression (${(e as Error).message})` };
    }
  }
  const verb = c.op === "equals" ? "is" : c.op === "contains" ? "contains" : "matches";
  const actual = c.check === "text" ? "" : ok && c.op === "equals" ? "" : ` (it is "${show(s.actual)}")`;
  return {
    ok,
    text: ok ? `${s.name} ${verb} "${expected}"${actual}` : `${s.name} ${c.op === "equals" ? "is not" : c.op === "contains" ? "does not contain" : "does not match"} "${expected}"${actual}`,
    ...(s.relocated ? { relocated: s.relocated } : {}),
  };
}

/** The captured value, or why there is none. */
export function captureValue(screen: ParsedScreen, c: Capture): { value: string } | { error: string } {
  const s = subject(screen, c);
  if (s.actual === undefined) return { error: `${s.name} is not on the screen, so \${${c.var}} could not be read` };
  if (!c.pattern) return s.actual.trim() ? { value: s.actual.trim() } : { error: `${s.name} is empty, so \${${c.var}} could not be read` };
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(c.pattern).exec(s.actual);
  } catch (e) {
    return { error: `"${c.pattern}" is not a regular expression (${(e as Error).message})` };
  }
  const v = m?.[1] ?? m?.[0];
  return v ? { value: v } : { error: `${s.name} is "${show(s.actual)}", which does not match ${c.pattern}: \${${c.var}} could not be read` };
}
