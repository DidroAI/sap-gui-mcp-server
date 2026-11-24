/**
 * The command line of record and replay:
 *
 *   sap-ui-automation replay <file>... [--var name=value]... [--session <ref>] [--loose] [--continue] [--stay] [--json] [--junit <file>]
 *   sap-ui-automation export <file> --to <target> [--out <file>]
 *
 * `replay` runs on a session the user has open, as the server does: it
 * never logs on. Exit code 0 when every test passed, 1 otherwise.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Policy } from "../core/guard.js";
import { Registry } from "../core/registry.js";
import type { Surface } from "../core/types.js";
import { exportTest, TARGET_NAMES, TARGETS } from "./export/index.js";
import { FILE_SUFFIX, parseTest } from "./format.js";
import { junit, replayAll, resultText } from "./replay.js";

export const RECORD_HELP = `  sap-ui-automation replay <file>... [--var name=value] [--session <ref>] [--loose] [--continue] [--stay] [--json] [--junit <file>]
                                run recorded tests (${FILE_SUFFIX}) on an open session, with no model; exit code 1 on a failure
  sap-ui-automation export <file> --to ${TARGET_NAMES.join("|")} [--out <file>]
                                write a recorded test in another format`;

interface Args {
  files: string[];
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(["--var", "--session", "--junit", "--to", "--out"]);

function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      files.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else flags.set(a, []);
  }
  return { files, flags };
}

async function load(path: string) {
  try {
    return parseTest(await readFile(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

export async function replayCommand(argv: string[], surfaces: Surface[], policy: Policy, out: (s: string) => void = console.log): Promise<number> {
  const { files, flags } = parseArgs(argv);
  if (!files.length) throw new Error("replay needs at least one recorded test file");
  const variables: Record<string, string> = {};
  for (const v of flags.get("--var") ?? []) {
    const i = v.indexOf("=");
    if (i < 1) throw new Error(`--var takes name=value (got "${v}")`);
    variables[v.slice(0, i)] = v.slice(i + 1);
  }
  const tests = await Promise.all(files.map(load));
  const known = new Set(tests.flatMap((t) => Object.keys(t.variables)));
  const unknown = Object.keys(variables).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`no test has a variable ${unknown.join(", ")} (they have: ${[...known].join(", ") || "none"})`);
  const registry = new Registry(surfaces, policy);
  try {
    const { driver } = await registry.session(flags.get("--session")?.[0]);
    const json = flags.has("--json");
    const results = await replayAll(driver, policy, tests, {
      variables,
      screens: flags.has("--loose") ? "loose" : "strict",
      ...(flags.has("--continue") ? { choices: "continue" as const } : {}),
      leaveOnFailure: !flags.has("--stay"),
    });
    if (json) out(JSON.stringify(results, null, 2));
    else out(results.map(resultText).join("\n\n"));
    const notRun = tests.length - results.length;
    if (notRun && !json) out(`\n${notRun} test(s) after the failure were not run.`);
    const report = flags.get("--junit")?.[0];
    if (report) await writeFile(report, junit(results), "utf8");
    return results.length === tests.length && results.every((r) => r.passed) ? 0 : 1;
  } finally {
    await registry.closeAll();
  }
}

export async function exportCommand(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { files, flags } = parseArgs(argv);
  const to = flags.get("--to")?.[0];
  if (files.length !== 1 || !to) throw new Error(`export takes one recorded test file and --to <target>:\n${TARGET_NAMES.map((t) => `  ${t.padEnd(15)} ${TARGETS[t].what}`).join("\n")}`);
  const file = files[0] as string;
  const r = exportTest(await load(file), to);
  const dest = flags.get("--out")?.[0];
  if (dest === "-") {
    out(r.text);
    return 0;
  }
  const path = dest ?? `${file.endsWith(FILE_SUFFIX) ? file.slice(0, -FILE_SUFFIX.length) : file}${r.suffix}`;
  await writeFile(path, r.text, "utf8");
  out(path);
  return 0;
}
