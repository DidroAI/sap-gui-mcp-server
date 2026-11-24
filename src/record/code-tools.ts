/**
 * Code tools: an agent without a file system saves a `*.sap.ts` test and
 * runs it through the runner (docs/reference/tools.md).
 *
 *   sap_code_save  {"name","code"}               writes <SAP_RECORD_DIR>/<slug>.sap.ts after the checks below
 *   sap_code_test  {"name","variables"?}         runs it on the active session, under the server's policy
 *
 * Off unless SAP_CODE_TOOLS=on. They let an agent write code that this
 * server then runs on the user's machine, and an agent reads SAP screens:
 * text on a screen (a note, a material description) can carry instructions
 * that reach the code it writes. The static checks here are defense in
 * depth, not a sandbox:
 *   - a syntax check (TypeScript types stripped: node:module, else Bun's transpiler);
 *   - imports: only `expect`, `test` (and types) from "sap-ui-automation/test" or "sap-ui-automation";
 *   - no `process`, `require`, `import()`, `eval`, `Function`, `globalThis`,
 *     `fetch`, `Bun`, `Deno`, `child_process`, nor the ways around them
 *     (`constructor`, `Reflect`, `Object`, the `registry`/`policy`/`driver`
 *     of a session), and no computed member access but `x[0]`;
 *   - commit parity: a call that may write (a save, key 11, a Save button)
 *     is refused unless the recording of the same name has a write.
 * At run time the runner's guard applies as for any script, with the
 * session, SAP_WRITE and the transaction lists clamped to the server's: a
 * test cannot ask for more (`test.use`, a test's own `use`).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mayDestroy, type Policy } from "../core/guard.js";
import type { Registry } from "../core/registry.js";
import { commitWord } from "../core/words.js";
import { resolveConfig } from "../runner/config.js";
import { driftLines } from "../runner/reporters.js";
import { runTests } from "../runner/run.js";
import { lockPathFor } from "../sdk/lock.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { exportTidy } from "./export/sap-ts-tidy.js";
import { type SapTest, slug } from "./format.js";
import type { Recorder } from "./recorder.js";
import type { Serial } from "./tools.js";

export const CODE_SUFFIX = ".sap.ts";
const MAX_CODE = 100_000;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: t }] });

/** Are the code tools on? SAP_CODE_TOOLS=on; anything else is off. */
export const codeToolsOn = (env: Record<string, string | undefined> = process.env): boolean => (env.SAP_CODE_TOOLS ?? "off").trim().toLowerCase() === "on";

// ---- reading code ---------------------------------------------------------------

export interface Scanned {
  /** The code with the inside of strings, template texts, regular expressions and comments blanked (line breaks kept). */
  code: string;
  /** Each string literal (and template text part): where it starts in the code, and its text. */
  strings: { at: number; value: string }[];
}

/** Separates code from text: what the checks read is never inside a string or a comment. */
export function scan(src: string): Scanned {
  const out = src.split("");
  const strings: Scanned["strings"] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Template literals nest: `a ${ f(`b`) } c`. The stack holds the brace depth at which each template expression opened.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  let lastSig = "";
  const readString = (quote: string): void => {
    const start = i;
    i++;
    let value = "";
    while (i < src.length && src[i] !== quote && src[i] !== "\n") {
      if (src[i] === "\\") {
        value += src[i + 1] ?? "";
        i += 2;
      } else value += src[i++];
    }
    strings.push({ at: start, value });
    blank(start + 1, i);
    i++;
  };
  /** Template text from i (just after ` or }) to the closing ` or the next ${. */
  const readTemplateText = (): void => {
    const start = i;
    let value = "";
    while (i < src.length && src[i] !== "`" && !(src[i] === "$" && src[i + 1] === "{")) {
      if (src[i] === "\\") {
        value += src[i + 1] ?? "";
        i += 2;
      } else value += src[i++];
    }
    strings.push({ at: start, value });
    blank(start, i);
    if (src[i] === "`") i++;
    else if (src[i] === "$") {
      i += 2;
      depth++;
      templates.push(depth);
    }
  };
  const regexAllowed = () => !lastSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || /^(return|typeof|case|do|else|in|of|void|await|yield)$/.test(lastSig);
  while (i < src.length) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      readString(c);
      lastSig = "str";
      continue;
    }
    if (c === "`") {
      i++;
      readTemplateText();
      lastSig = "str";
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "[") (inClass = true), i++;
        else if (src[i] === "]") (inClass = false), i++;
        else if (src[i] === "/" && !inClass) break;
        else i++;
      }
      blank(start + 1, i);
      i++;
      while (i < src.length && /[a-z]/.test(src[i] as string)) i++;
      lastSig = "re";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.at(-1) === depth) {
        templates.pop();
        depth--;
        i++;
        readTemplateText();
        lastSig = "str";
        continue;
      }
      depth--;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)) as RegExpExecArray;
      lastSig = m[0];
      i += m[0].length;
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return { code: out.join(""), strings };
}

/** Words code may not hold outside strings: the ways out of a test, and around the checks. */
export const FORBIDDEN = [
  "process", "require", "eval", "Function", "globalThis", "global", "window", "fetch", "Bun", "Deno", "child_process", "module", "exports", "__dirname", "__filename",
  "constructor", "prototype", "__proto__", "Reflect", "Proxy", "Object", "Symbol", "WebAssembly", "Worker", "XMLHttpRequest", "WebSocket", "Atomics", "SharedArrayBuffer",
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "__defineGetter__", "__lookupGetter__", "debugger", "with",
  // A session's insides: its driver acts without the guard, its policy is the guard's.
  "registry", "policy", "driver", "recorder", "options", "surfaces",
];

const FORBIDDEN_STRINGS = new Set(["constructor", "prototype", "__proto__", "eval", "Function", "globalThis", "process", "require", "child_process", "registry", "policy", "driver"]);
/** Words after which `[` opens an array, not a member access. */
const KEYWORDS_BEFORE_ARRAY = new Set(["return", "await", "of", "in", "case", "typeof", "yield", "else", "do", "void", "throw"]);

/** What each allowed module may give. Types (`import type`, `type X`) are always allowed. */
const ALLOWED: Record<string, Set<string>> = {
  "sap-ui-automation/test": new Set(["expect", "test", "ExpectError"]),
  "sap-ui-automation": new Set(["expect", "ExpectError", "Refused"]),
};

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

/** The problems of the code's imports and words; empty when it passes. */
export function staticProblems(src: string): string[] {
  const problems: string[] = [];
  if (src.length > MAX_CODE) return [`the code is ${src.length} characters; at most ${MAX_CODE}`];
  const { code, strings } = scan(src);
  const stringAt = (from: number) => strings.find((s) => s.at >= from);
  // "\u0070rocess" is the identifier "process": a word spelled with escapes would pass every check below.
  for (const m of code.matchAll(/\\u/g)) problems.push(`line ${lineOf(src, m.index ?? 0)}: a \\u escape outside a string is not allowed in a test`);
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const word = m[0];
    const at = m.index ?? 0;
    if (FORBIDDEN.includes(word)) problems.push(`line ${lineOf(src, at)}: "${word}" is not allowed in a test`);
    if (word === "import" || word === "export") {
      const next = code.slice(at + word.length).trimStart()[0];
      if (word === "import" && (next === "(" || next === ".")) {
        problems.push(`line ${lineOf(src, at)}: import${next === "(" ? "()" : ".meta"} is not allowed: only static imports from ${Object.keys(ALLOWED).join(" or ")}`);
        continue;
      }
      // The statement: up to its module string (import ... from "x", import "x", export ... from "x").
      const end = code.indexOf(";", at);
      const stmt = code.slice(at, end < 0 ? undefined : end);
      if (word === "export" && !/\bfrom\b/.test(stmt)) continue;
      const lit = stringAt(at);
      const spec = lit && (end < 0 || lit.at < end) ? lit.value : undefined;
      const names = ALLOWED[spec ?? ""];
      if (!spec || !names) {
        problems.push(`line ${lineOf(src, at)}: imports only from ${Object.keys(ALLOWED).map((x) => `"${x}"`).join(" or ")}${spec ? ` (not "${spec}")` : ""}`);
        continue;
      }
      if (word === "export") {
        problems.push(`line ${lineOf(src, at)}: a test does not re-export`);
        continue;
      }
      const head = src.slice(at, lit?.at);
      if (/^import\s+type\b/.test(head)) continue;
      const braces = /\{([^}]*)\}/.exec(head);
      if (!braces || /^import\s+[\w$]+\s*,/.test(head) || /\*\s*as\b/.test(head)) {
        problems.push(`line ${lineOf(src, at)}: import named exports only: import { expect, test } from "${spec}"`);
        continue;
      }
      for (const part of (braces[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
        if (/^type\s/.test(part)) continue;
        const name = part.split(/\s+as\s+/)[0]?.trim() ?? "";
        if (!names.has(name)) problems.push(`line ${lineOf(src, at)}: "${name}" from "${spec}" is not allowed in a test (allowed: ${[...names].join(", ")})`);
      }
    }
  }
  // Computed member access reaches anything by a name built at run time: only a number in brackets.
  for (const m of code.matchAll(/([\w$]+|[)\]]|\?\.)\s*\[([^\]]*)\]/g)) {
    if (KEYWORDS_BEFORE_ARRAY.has(m[1] ?? "")) continue;
    const inside = (m[2] ?? "").trim();
    if (inside && !/^\d+$/.test(inside)) problems.push(`line ${lineOf(src, m.index ?? 0)}: x[${inside}] is not allowed: only a number in brackets (use .at(i) for an array)`);
  }
  // A string that is one of these names is a way to reach it anyway.
  for (const s of strings) if (FORBIDDEN_STRINGS.has(s.value.trim())) problems.push(`line ${lineOf(src, s.at)}: the string "${s.value.trim()}" is not allowed in a test`);
  return [...new Set(problems)];
}

/**
 * Calls in the code that may write to SAP, as read from its text: what commit parity compares with the recording.
 * `written`: ids of the controls the recording's writes acted on. A press of one of them is a write too, whatever
 * its name says: "Yes" on SAP's save question is `btnSPOP-OPTION1` (live 2026-11-21, it was counted as no write).
 */
export function commitCalls(src: string, written: readonly string[] = []): string[] {
  const out: string[] = [];
  const ids = new Set(written.map(bareId).filter(Boolean));
  if (ids.size)
    for (const m of src.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
      const id = bareId(m[1] ?? "");
      if (ids.has(id) && !/\.(?:okcode|key)\s*\(\s*$/.test(src.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) out.push(`line ${lineOf(src, m.index ?? 0)}: ${m[1]} (a control the recording wrote with)`);
    }
  const arg = `\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1\\s*`;
  for (const m of src.matchAll(/\.save\s*\(/g)) out.push(`line ${lineOf(src, m.index ?? 0)}: sap.save()`);
  for (const m of src.matchAll(new RegExp(`\\.key\\((?:${arg}|\\s*(\\d+)\\s*)\\)`, "g"))) {
    const k = m[3] !== undefined ? Number(m[3]) : m[2];
    if (vkeyNumber(k) === 11) out.push(`line ${lineOf(src, m.index ?? 0)}: key ${String(k)} (Save)`);
  }
  for (const m of src.matchAll(/["']?key["']?\s*:\s*(?:(\d+)|["'`]([^"'`]*)["'`])/g)) {
    const k = m[1] !== undefined ? Number(m[1]) : m[2];
    if (vkeyNumber(k) === 11) out.push(`line ${lineOf(src, m.index ?? 0)}: key ${String(k)} (Save)`);
  }
  for (const m of src.matchAll(new RegExp(`\\.button\\(${arg}\\)`, "g"))) {
    const word = commitWord(m[2]);
    if (word) out.push(`line ${lineOf(src, m.index ?? 0)}: the button "${m[2]}" (${word})`);
  }
  for (const m of src.matchAll(new RegExp(`\\.press\\(${arg}[,)]`, "g"))) if (/btn\[11\]$/.test(m[2] ?? "")) out.push(`line ${lineOf(src, m.index ?? 0)}: press ${m[2]} (Save)`);
  for (const m of src.matchAll(new RegExp(`\\.okcode\\(${arg}\\)`, "g"))) {
    const v = (m[2] ?? "").trim();
    if (/^\/11$/.test(v) || /^[=/]?(SICH|SAVE|BU|POST)$/i.test(v)) out.push(`line ${lineOf(src, m.index ?? 0)}: okcode ${v} (Save)`);
  }
  return out;
}

/** The syntax check: the code with its types stripped must parse. Which checker ran, or undefined when none is there. */
export async function syntaxProblem(src: string): Promise<{ by?: string; problem?: string }> {
  const mod = (await import("node:module")) as { stripTypeScriptTypes?: (code: string) => string };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
  if (typeof mod.stripTypeScriptTypes === "function") {
    try {
      mod.stripTypeScriptTypes(src);
      return { by: "node:module" };
    } catch (e) {
      return { by: "node:module", problem: msg(e) };
    }
  }
  const bun = (globalThis as { Bun?: { Transpiler: new (o: { loader: string }) => { transformSync(code: string): string } } }).Bun;
  if (bun) {
    try {
      new bun.Transpiler({ loader: "ts" }).transformSync(src);
      return { by: "Bun.Transpiler" };
    } catch (e) {
      return { by: "Bun.Transpiler", problem: msg(e) };
    }
  }
  return {};
}

export interface CodeCheck {
  ok: boolean;
  problems: string[];
  /** What was checked, for the answer. */
  checked: string[];
}

/** Every check of a test's code. `recording`: the recording of the same name, for commit parity (none: a call that may write is refused). */
export async function checkCode(src: string, recording: SapTest | undefined): Promise<CodeCheck> {
  const problems = staticProblems(src);
  const checked = ["imports", "forbidden words", "computed access"];
  const syntax = await syntaxProblem(src);
  if (syntax.problem) problems.unshift(`syntax: ${syntax.problem}`);
  checked.unshift(syntax.by ? `syntax (${syntax.by})` : "syntax: not checked (no TypeScript parser in this runtime)");
  const written = (recording?.steps ?? []).filter((s) => s.risk === "commit").map((s) => String(s.action?.id ?? "")).filter(Boolean);
  const writes = [...new Set(commitCalls(src, written))];
  const recorded = recording?.steps.some((s) => s.risk === "commit");
  if (writes.length && !recorded)
    problems.push(
      `${writes.join("; ")}: may write to SAP, and ${recording ? `the recording "${recording.name}" has no write` : "there is no recording of this name to compare with"}. Code saved here may write only where its recording did: record the flow with the save first.`,
    );
  checked.push(`commit parity (${writes.length} call(s) that may write; ${recording ? `recording ${recorded ? "has" : "has no"} write` : "no recording"})`);
  return { ok: !problems.length, problems, checked };
}

// ---- files ----------------------------------------------------------------------

/** The file of a code test by name: a name, never a path. */
export function codePath(dir: string, name: string): string {
  const n = name.trim();
  if (!n || /[/\\]|\.\.|^\.|^[A-Za-z]:/.test(n)) throw new Error(`"${name}" is not a name: give the test's name (letters, digits, spaces), never a path.`);
  return join(dir, `${slug(n.replace(/\.sap\.ts$/i, ""))}${CODE_SUFFIX}`);
}

/** The runner's entry as this installation has it (src under bun, dist under node). */
function entry(rel: string): string {
  const js = fileURLToPath(new URL(rel, import.meta.url));
  return existsSync(js) ? js : js.replace(/\.js$/, ".ts");
}

/**
 * The copy of a test that runs: its imports pointed at this installation (the
 * recordings directory has no node_modules), its `vars` overridden on the
 * same line (line numbers stay), types stripped where Node runs it.
 */
async function runnable(src: string, variables: Record<string, string> | undefined): Promise<{ code: string; ext: string }> {
  let code = src.replace(/(["'])sap-ui-automation\/test\1/g, JSON.stringify(entry("../runner/index.js"))).replace(/(["'])sap-ui-automation\1/g, JSON.stringify(entry("../index.js")));
  if (variables && Object.keys(variables).length) {
    const lines = code.split("\n");
    const open = lines.findIndex((l) => /^\s*const vars = \{\s*$/.test(l));
    const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && /^\s*\};\s*$/.test(l));
    if (close < 0) throw new Error('"variables" needs the test to have a `const vars = {` ... `};` block (as exported code has).');
    lines[close] = (lines[close] as string).replace("};", `...${JSON.stringify(variables)}};`);
    code = lines.join("\n");
  }
  const mod = (await import("node:module")) as { stripTypeScriptTypes?: (code: string) => string };
  if (typeof mod.stripTypeScriptTypes === "function" && !(globalThis as { Bun?: unknown }).Bun) return { code: mod.stripTypeScriptTypes(code), ext: ".mjs" };
  return { code, ext: ".ts" };
}

// ---- tidy answer -----------------------------------------------------------------

/** What `sap_record {"op":"code","tidy":true}` answers: the tidied code, what was removed and why, and what to look at. */
export function tidyAnswer(test: SapTest): string {
  const r = exportTidy(test);
  return [
    r.text,
    "Changes (tidy):",
    ...r.log.map((l) => `- ${l}`),
    ...(r.todo.length ? ["", "TODO:", ...r.todo.map((l) => `- ${l}`)] : []),
    "",
    "Not verified on a system: run it (sap_code_test after sap_code_save, or the runner) before relying on it. A removal that was needed shows up as a failure at the step after it.",
  ].join("\n");
}

// ---- tools ------------------------------------------------------------------------

const DESCRIPTION_RISK =
  "Enabled by SAP_CODE_TOOLS=on: the code runs on the user's machine, and text read from SAP screens can try to steer what an agent writes. The checks (imports, forbidden words, commit parity) are defense in depth, not a sandbox.";

export function registerCodeTools(server: McpServer, registry: Registry, policy: Policy, recorder: Recorder, serial: Serial = (_r, _l, f) => f(), env: Record<string, string | undefined> = process.env): boolean {
  if (!codeToolsOn(env)) return false;
  const answer = async (f: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await f();
    } catch (e) {
      return fail((e as Error).message);
    }
  };
  const recordingOf = (name: string) => recorder.load(name).catch(() => undefined);

  server.registerTool(
    "sap_code_save",
    {
      title: "Save a *.sap.ts test",
      description: `Writes a test written with the scripting API (import { expect, test } from "sap-ui-automation/test") to <name>${CODE_SUFFIX} in the recordings directory, after checks: syntax, imports (only expect and test from the package), no process/require/import()/eval/fetch and the like, and no call that may write (a save, key 11, a Save button) unless the recording of the same name has a write. Start from sap_record {"op":"code","tidy":true}. ${DESCRIPTION_RISK}`,
      inputSchema: {
        name: z.string().min(1).describe("the test's name, as the recording's (never a path)"),
        code: z.string().min(1).describe("the whole *.sap.ts file"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (a) =>
      answer(async () => {
        const path = codePath(recorder.options.dir, a.name);
        const check = await checkCode(a.code, await recordingOf(a.name));
        if (!check.ok) return fail(`Not saved: ${check.problems.length} problem(s).\n${check.problems.map((p) => `- ${p}`).join("\n")}\nChecked: ${check.checked.join(", ")}.`);
        await mkdir(recorder.options.dir, { recursive: true });
        await writeFile(path, a.code, "utf8");
        return text(`Saved ${path}. Checked: ${check.checked.join(", ")}. Not type-checked against the SDK. Run it with sap_code_test {"name":${JSON.stringify(a.name)}}.`);
      }),
  );

  server.registerTool(
    "sap_code_test",
    {
      title: "Run a saved *.sap.ts test",
      description: `Runs a test saved with sap_code_save on the active session through the test runner, under the server's policy (SAP_WRITE, transaction lists; the test cannot widen them). Answers pass or fail; on a failure the line, the sap.step it was in, the screen there and the trace file. Verified against <name>.sap.lock.json (what the screens looked like on a passing run, written by the first pass): where SAP answers otherwise it fails with "Drift" (the step, the action, the screen); fix the code with sap_code_save if SAP changed. "variables" overrides values of the test's \`const vars\`. ${DESCRIPTION_RISK}`,
      inputSchema: {
        name: z.string().min(1).describe("the test's name, as saved"),
        variables: z.record(z.string(), z.string()).optional(),
        session: z.string().optional().describe("session from sap_sessions; default: the active one"),
      },
      annotations: { readOnlyHint: false, destructiveHint: mayDestroy(policy), openWorldHint: false },
    },
    (a) =>
      answer(async () => {
        if (recorder.recording) return fail('A recording is on: stop it first with sap_record {"op":"stop"}.');
        const path = codePath(recorder.options.dir, a.name);
        const src = await readFile(path, "utf8").catch(() => undefined);
        if (src === undefined) return fail(`No test "${a.name}" (looked for ${path}). Save it with sap_code_save first.`);
        // The file may have changed since it was saved: the checks again.
        const check = await checkCode(src, await recordingOf(a.name));
        if (!check.ok) return fail(`Not run: ${check.problems.map((p) => `\n- ${p}`).join("")}`);
        return serial(a.session, `sap_code_test ${a.name}`, async () => {
          const { driver, info } = await registry.session(a.session);
          const { code, ext } = await runnable(src, a.variables);
          const runs = join(recorder.options.dir, ".sap-code-runs");
          await mkdir(runs, { recursive: true });
          const copy = join(runs, `${slug(a.name)}-${Date.now()}${ext}`);
          await writeFile(copy, code, "utf8");
          // The lock is the saved file's, not the copy's.
          const lockFile = lockPathFor(path);
          try {
            const config = resolveConfig({ outputDir: "sap-results", timeout: 120_000 }, recorder.options.dir);
            const result = await runTests({
              config,
              files: [copy],
              lockFile: () => lockFile,
              surfaces: registry.surfaces,
              clamp: { session: info.id, write: policy.write, ...(policy.allowTcodes ? { allowTcodes: policy.allowTcodes } : {}), ...(policy.blockTcodes ? { blockTcodes: policy.blockTcodes } : {}) },
            });
            if (!result.tests.length) return fail(`${path} declares no test: write test("...", async ({ sap }) => { ... }).`);
            const lines: string[] = [];
            const srcLines = src.split("\n");
            for (const t of result.tests) {
              const head = `${t.status === "passed" ? "PASS" : t.status.toUpperCase()}  ${t.title.replace(/^loading .*/, `loading ${path}`)}  (${(t.ms / 1000).toFixed(1)} s)`;
              lines.push(head);
              if (t.error) {
                const msg = t.error.message.split(copy).join(path);
                lines.push(`  error: ${msg}`);
                const at = new RegExp(`${copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(t.error.stack ?? "");
                if (at) lines.push(`  line ${at[1]}: ${(srcLines[Number(at[1]) - 1] ?? "").trim()}`);
                const step = /\(in step "(.*)"\)/.exec(t.error.message)?.[1];
                if (step) lines.push(`  step: ${step}`);
                for (const l of driftLines(t)) lines.push(`  ${l.split(copy).join(path)}`);
              }
              const l = t.lock;
              if (l && !t.drift) lines.push(`  lock: ${l.verified} action(s) as the lock has them, ${l.unverified} new${l.written ? `; written to ${l.file}` : ""}${l.notes.length ? ` (${l.notes.join("; ")})` : ""}`);
              if (t.trace) lines.push(`  trace: ${t.trace}`);
            }
            if (!result.ok) {
              const screen = await driver.look({ compact: true }).catch(() => undefined);
              if (screen) lines.push("", "Screen now:", screen);
            }
            return result.ok ? text(lines.join("\n")) : fail(lines.join("\n"));
          } finally {
            await rm(copy, { force: true });
          }
        });
      }),
  );
  return true;
}

/** A control id without its window path and type prefix, as code and recordings may write it either way. */
function bareId(id: string): string {
  const last = id.trim().replace(/^.*\//, "");
  return /^[a-z]+[A-Z%<*]/.test(last) ? last.replace(/^[a-z]+/, "").toLowerCase() : last.toLowerCase();
}
