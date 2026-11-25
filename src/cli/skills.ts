/**
 * `install --skills`: copies the skills shipped in this package (`skills/<name>/SKILL.md`
 * and whatever else is in that folder) to where agents read them:
 *
 * - Claude Code: `.claude/skills/<name>/` in the project, or `~/.claude/skills/<name>/` (--global);
 * - Codex: `.agents/skills/<name>/` in the project, or `~/.agents/skills/<name>/` (--global),
 *   where Codex reads a user's skills;
 * - Cursor: `.cursor/rules/<name>.mdc` in the project (Cursor has no user rule files,
 *   so --global skips it); the SKILL.md frontmatter becomes a rule's
 *   `description` with `alwaysApply: false`, so Cursor picks it by description.
 *
 * It is idempotent: a file with the same content is left alone and reported unchanged.
 * A file that differs is replaced, unless `overwrite` is false (init without
 * --force): then it is kept, as the user may have edited it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_TARGETS = ["claude", "codex", "cursor"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/** The package root: two levels up from src/cli/ (bun) or dist/cli/ (node). */
export function packageRoot(from: string = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..", "..");
}

export interface Skill {
  name: string;
  dir: string;
  /** Paths relative to `dir`, SKILL.md included. */
  files: string[];
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
    });
}

/** Every `skills/<name>/` folder that has a SKILL.md. */
export function shippedSkills(root: string = packageRoot()): Skill[] {
  const dir = join(root, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((n) => existsSync(join(dir, n, "SKILL.md")))
    .map((name) => ({ name, dir: join(dir, name), files: walk(join(dir, name)) }));
}

/** SKILL.md (frontmatter `name`, `description`) as a Cursor rule. */
export function cursorRule(skillMd: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skillMd);
  const front = m?.[1] ?? "";
  const body = m ? skillMd.slice(m[0].length) : skillMd;
  const description = /^description:[ \t]*(.*)$/m.exec(front)?.[1]?.trim() ?? "";
  return `---\ndescription: ${description}\nglobs:\nalwaysApply: false\n---\n${body}`;
}

export type FileState = "created" | "updated" | "unchanged" | "kept";

export interface InstallResult {
  lines: string[];
  files: { path: string; state: FileState }[];
}

export interface InstallOptions {
  targets: SkillTarget[];
  global?: boolean;
  dryRun?: boolean;
  cwd?: string | undefined;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Where the skills come from (tests). Default: this package. */
  root?: string | undefined;
  /** Replace a file that differs from the shipped one. Default: true. */
  overwrite?: boolean;
}

/** The file's content, or undefined when there is no such file. Read once, with no check before. */
export function readIfThere(path: string): Buffer | undefined;
export function readIfThere(path: string, encoding: "utf8"): string | undefined;
export function readIfThere(path: string, encoding?: "utf8"): Buffer | string | undefined {
  try {
    return encoding ? readFileSync(path, encoding) : readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function put(path: string, content: string | Buffer, dryRun: boolean, overwrite: boolean): FileState {
  const old = readIfThere(path);
  if (old?.equals(Buffer.from(content))) return "unchanged";
  if (old !== undefined && !overwrite) return "kept";
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    // A file that was not there is only created: one made meanwhile is not overwritten.
    writeFileSync(path, content, { flag: old === undefined ? "wx" : "w" });
  }
  return old === undefined ? "created" : "updated";
}

const LABEL: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

/** Where a target's skills go; undefined when the target has no such scope. */
export function skillsDir(target: SkillTarget, global: boolean, cwd: string, home: string, env: Record<string, string | undefined>): string | undefined {
  if (target === "claude") return global ? join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills") : join(cwd, ".claude", "skills");
  if (target === "codex") return join(global ? home : cwd, ".agents", "skills");
  return global ? undefined : join(cwd, ".cursor", "rules");
}

export function installSkills(opts: InstallOptions): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const dryRun = !!opts.dryRun;
  const overwrite = opts.overwrite ?? true;
  const skills = shippedSkills(opts.root);
  const lines: string[] = [];
  const files: InstallResult["files"] = [];
  if (!skills.length) return { lines: [`✗ Skills: none found in ${join(opts.root ?? packageRoot(), "skills")}.`], files };
  const show = (p: string) => (p.startsWith(cwd + sep) ? relative(cwd, p) : p.startsWith(home + sep) ? join("~", relative(home, p)) : p);
  const verb = (s: FileState) => (s === "kept" ? "differs, kept (--force replaces it)" : dryRun && s !== "unchanged" ? `would be ${s}` : s);

  for (const target of opts.targets) {
    const dir = skillsDir(target, !!opts.global, cwd, home, env);
    if (!dir) {
      lines.push(`– ${LABEL[target]} skills: Cursor has no user-level rule files; run without --global in the project.`);
      continue;
    }
    for (const skill of skills) {
      let state: FileState;
      let shown: string;
      if (target === "cursor") {
        shown = join(dir, `${skill.name}.mdc`);
        state = put(shown, cursorRule(readFileSync(join(skill.dir, "SKILL.md"), "utf8")), dryRun, overwrite);
        files.push({ path: shown, state });
      } else {
        shown = join(dir, skill.name);
        const states = skill.files.map((f) => {
          const path = join(shown, f);
          const s = put(path, readFileSync(join(skill.dir, f)), dryRun, overwrite);
          files.push({ path, state: s });
          return s;
        });
        // The skill is new when its SKILL.md is; a file left as the user had it makes it kept; any other change is an update.
        const main = states[skill.files.indexOf("SKILL.md")];
        state = main === "created" ? "created" : states.includes("kept") ? "kept" : states.every((s) => s === "unchanged") ? "unchanged" : "updated";
      }
      lines.push(`${state === "unchanged" ? "✓" : state === "kept" ? "–" : "•"} ${LABEL[target]} skill ${skill.name}: ${verb(state)} (${show(shown)})`);
    }
  }
  return { lines, files };
}

// ---------------------------------------------------------------- setup: the skills, for the user, with the MCP server

/**
 * Where each agent app reads a user's skills. Cursor also reads Claude Code's and the shared
 * `~/.agents/skills` folder, so it gets a folder of its own only when neither is written.
 * Claude Desktop, Windsurf and VS Code read no skills from disk.
 */
export function userSkillDirs(clients: string[], home: string, env: Record<string, string | undefined>): { dir: string; clients: string[] }[] {
  const dirs: { dir: string; clients: string[] }[] = [];
  if (clients.includes("claude-code")) dirs.push({ dir: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), clients: ["claude-code"] });
  if (clients.includes("codex")) dirs.push({ dir: join(home, ".agents", "skills"), clients: ["codex"] });
  if (clients.includes("cursor")) {
    const shared = dirs[0];
    if (shared) shared.clients.push("cursor");
    else dirs.push({ dir: join(home, ".cursor", "skills"), clients: ["cursor"] });
  }
  return dirs;
}

/** Left in each skill folder setup writes, so that only those are replaced later. */
export const SKILL_MARKER = ".sap-ui-automation";

/**
 * Whether a skill folder is one this package installed: it holds the marker, or (copied before the
 * marker existed, by `install --skills --global`) a SKILL.md of that name that uses this server.
 * A folder someone made themselves is not.
 */
export function ownSkill(target: string): boolean {
  if (existsSync(join(target, SKILL_MARKER))) return true;
  const text = readIfThere(join(target, "SKILL.md"), "utf8");
  return !!text && new RegExp(`^name: ${target.split(/[\\/]/).pop()}$`, "m").test(text) && /\bsap-ui-automation\b/.test(text);
}

/**
 * Copies the shipped skills into a folder, replacing this package's copies from an earlier version;
 * a folder of the same name that is not ours stays. Returns what was installed and what was left.
 */
export function setupSkills(dir: string, dryRun: boolean, root: string = packageRoot()): { installed: string[]; left: string[] } {
  const installed: string[] = [];
  const left: string[] = [];
  for (const skill of shippedSkills(root)) {
    const target = join(dir, skill.name);
    if (existsSync(target) && !ownSkill(target)) {
      left.push(skill.name);
      continue;
    }
    installed.push(skill.name);
    if (dryRun) continue;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(skill.dir, target, { recursive: true });
    writeFileSync(join(target, SKILL_MARKER), "Installed by sap-ui-automation setup; replaced on the next setup.\n");
  }
  return { installed, left };
}
