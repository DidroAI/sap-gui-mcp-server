/**
 * `init`: sets a project up for SAP tests and agents, in one go:
 *
 *   sap.config.ts             the test runner's settings (surface, system, write mode)
 *   sap-tests/example.sap.ts  a read-only example test
 *   skills                    for the agents chosen (see skills.ts)
 *   MCP clients               registered through setup() (see setup.ts)
 *   .gitignore                gains .sap-gui/ and sap-results/ when the project has one or is a git repository
 *
 * Interactive by default (a few questions, Enter keeps the default); `--yes`,
 * or a stdin that is not a terminal, takes every default. Existing files are
 * left alone unless `--force`. `--dry-run` says what it would do.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SurfaceName } from "../core/types.js";
import { type Client, CLIENTS, detectClients, setup } from "./setup.js";
import { installSkills, readIfThere, type SkillTarget } from "./skills.js";

type Env = Record<string, string | undefined>;
type WriteMode = "off" | "confirm" | "on";
const SURFACES: SurfaceName[] = ["sapgui", "webgui", "fiori"];
const WRITES: WriteMode[] = ["off", "confirm", "on"];

export interface InitAnswers {
  surfaces: SurfaceName[];
  /** "ABA" or "ABA/800"; empty: the first session found. */
  system: string;
  write: WriteMode;
  clients: Client[];
}

export interface InitOptions {
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  cwd?: string | undefined;
  home?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  /** Asks one question, returns the answer ("" keeps the default). Not called with `yes`. */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Whether a command is on PATH (tests replace it). */
  onPath?: ((cmd: string) => boolean) | undefined;
  /** Where the skills come from (tests). */
  skillsRoot?: string;
}

export function defaultAnswers(platform: NodeJS.Platform, detected: Client[]): InitAnswers {
  return { surfaces: platform === "win32" ? ["sapgui", "webgui"] : ["webgui"], system: "", write: "off", clients: detected };
}

const q = (s: string) => JSON.stringify(s);

export function configFile(a: InitAnswers): string {
  const surface = a.surfaces.length === 1 ? q(a.surfaces[0] ?? "webgui") : `[${a.surfaces.map(q).join(", ")}]`;
  return `import { defineConfig } from "sap-ui-automation/test";

export default defineConfig({
  testDir: "sap-tests",
  timeout: 60_000,
  expectTimeout: 5_000,
  retries: 0,
  outputDir: "sap-results",
  use: {
    surface: ${surface},
${a.system ? `    system: ${q(a.system)},\n` : `    // system: "ABA/800",  // default: the first SAP session found\n`}    // Actions that may save in SAP: "off" refuses them, "on" runs them. "confirm" (the default) refuses
    // them too here: a test has nobody to ask.
    write: ${q(a.write)},
    // allowTcodes: ["VA03", "SU3"],
    // blockTcodes: ["SE38", "SM30"],
  },
});
`;
}

export function exampleTest(surface: SurfaceName): string {
  if (surface === "fiori")
    return `import { expect, test } from "sap-ui-automation/test";

// Read-only: opens the launchpad home page and checks that no error shows.
test("the launchpad opens", async ({ sap }) => {
  await sap.open("#Shell-home");
  await expect(sap.status()).not.toBeError();
});
`;
  return `import { expect, test } from "sap-ui-automation/test";

// Read-only: opens SU3 (your own user data) and checks where it landed.
// It saves nothing, so it runs under write: "off".
test("SU3 shows my user", async ({ sap }) => {
  await sap.okcode("/nSU3");
  await expect(sap).toHaveTransaction("SU3");
  await expect(sap.status()).not.toBeError();
});
`;
}

const SKILL_OF: Partial<Record<Client, SkillTarget>> = { "claude-code": "claude", codex: "codex", cursor: "cursor" };

/** Skill targets for the chosen clients; Claude Code's project skills when none has any. */
export function skillTargets(clients: Client[]): SkillTarget[] {
  const t = [...new Set(clients.map((c) => SKILL_OF[c]).filter((x): x is SkillTarget => !!x))];
  return t.length ? t : ["claude"];
}

function list<T extends string>(answer: string, allowed: readonly T[], fallback: T[]): T[] {
  const a = answer.trim().toLowerCase();
  if (!a) return fallback;
  if (a === "none") return [];
  const picked = a.split(/[\s,]+/).filter((x): x is T => (allowed as readonly string[]).includes(x));
  return picked.length ? [...new Set(picked)] : fallback;
}

async function interview(ask: NonNullable<InitOptions["ask"]>, d: InitAnswers, detected: Client[]): Promise<InitAnswers> {
  const surfaces = list(await ask(`Surfaces (${SURFACES.join(", ")}) [${d.surfaces.join(",")}]: `), SURFACES, d.surfaces);
  const system = (await ask(`SAP system id, e.g. ABA or ABA/800 (Enter: the first session found) [${d.system}]: `)).trim() || d.system;
  const w = (await ask(`Write mode (${WRITES.join(", ")}) [${d.write}]: `)).trim().toLowerCase();
  const write = (WRITES as string[]).includes(w) ? (w as WriteMode) : d.write;
  const found = detected.length ? `found: ${detected.join(", ")}` : "none found";
  const clients = list(await ask(`Register the MCP server in (${CLIENTS.join(", ")}, or none; ${found}) [${d.clients.join(",") || "none"}]: `), CLIENTS, d.clients);
  return { surfaces: surfaces.length ? surfaces : d.surfaces, system, write, clients };
}

export interface InitResult {
  lines: string[];
  answers: InitAnswers;
}

export async function init(opts: InitOptions = {}): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const dryRun = !!opts.dryRun;
  const detected = detectClients({ cwd, onPath: opts.onPath }, env, platform, home);
  const defaults = defaultAnswers(platform, detected);
  const answers = opts.yes || !opts.ask ? defaults : await interview(opts.ask, defaults, detected);
  const lines: string[] = [];
  const rel = (p: string) => relative(cwd, p) || p;

  const write = (path: string, content: string) => {
    const old = readIfThere(path, "utf8");
    const exists = old !== undefined;
    if (exists && !opts.force) return lines.push(`– ${rel(path)}: exists, skipped (--force overwrites it)`);
    if (old === content) return lines.push(`✓ ${rel(path)}: unchanged`);
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      // A file that was not there is only created: one made meanwhile is not overwritten.
      writeFileSync(path, content, { flag: exists ? "w" : "wx" });
    }
    lines.push(`${dryRun ? "•" : "✓"} ${rel(path)}: ${dryRun ? "would be " : ""}${exists ? "overwritten" : "written"}`);
  };
  write(join(cwd, "sap.config.ts"), configFile(answers));
  write(join(cwd, "sap-tests", "example.sap.ts"), exampleTest(answers.surfaces[0] ?? "webgui"));

  const skills = installSkills({ targets: skillTargets(answers.clients), dryRun, cwd, home, env, root: opts.skillsRoot, overwrite: !!opts.force });
  lines.push(...skills.lines);

  if (answers.clients.length) {
    const r = setup({ dryRun, only: answers.clients, cwd, onPath: opts.onPath, verbose: true }, env, platform, home);
    lines.push(...r.lines.filter((l) => /^[✓✗•–] /.test(l)));
  } else lines.push("– MCP clients: none chosen (run npx -y sap-ui-automation setup later)");

  const gitignore = join(cwd, ".gitignore");
  // A git project without a .gitignore gets one: traces and results hold business data.
  let found: string | undefined;
  try {
    found = readFileSync(gitignore, "utf8");
  } catch {
    // no .gitignore yet
  }
  if (found !== undefined || existsSync(join(cwd, ".git"))) {
    const text = found ?? "";
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const missing = [".sap-gui/", "sap-results/"].filter((e) => !have.has(e) && !have.has(e.slice(0, -1)));
    if (!missing.length) lines.push("✓ .gitignore: already ignores .sap-gui/ and sap-results/");
    else {
      // Appended, not rewritten: lines another program adds meanwhile are kept.
      if (!dryRun) appendFileSync(gitignore, `${text && !text.endsWith("\n") ? "\n" : ""}# sap-ui-automation: traces and test results hold screens of business data\n${missing.join("\n")}\n`);
      lines.push(`${dryRun ? "• .gitignore: would add" : "✓ .gitignore: added"} ${missing.join(", ")}`);
    }
  }

  lines.push(`Next: open an SAP screen, then ask your agent to look at it, or run the example in sap-tests/.`);
  return { lines, answers };
}
