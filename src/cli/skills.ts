/**
 * `install --skills`: copies the skills shipped in this package (`skills/<name>/SKILL.md`
 * and whatever else is in that folder) to where agents read them:
 *
 * - Claude Code: `.claude/skills/<name>/` in the project, or `~/.claude/skills/<name>/` (--global);
 * - Codex: `.agents/skills/<name>/` in the project, or `$CODEX_HOME/skills/<name>/`
 *   (default `~/.codex/skills`) with --global;
 * - Cursor: `.cursor/rules/<name>.mdc` in the project (Cursor has no user rule files,
 *   so --global skips it); the SKILL.md frontmatter becomes a rule's
 *   `description` with `alwaysApply: false`, so Cursor picks it by description.
 *
 * It is idempotent: a file with the same content is left alone and reported unchanged.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

export type FileState = "created" | "updated" | "unchanged";

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
}

function put(path: string, content: string | Buffer, dryRun: boolean): FileState {
  const old = existsSync(path) ? readFileSync(path) : undefined;
  if (old?.equals(Buffer.from(content))) return "unchanged";
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return old === undefined ? "created" : "updated";
}

const LABEL: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

/** Where a target's skills go; undefined when the target has no such scope. */
export function skillsDir(target: SkillTarget, global: boolean, cwd: string, home: string, env: Record<string, string | undefined>): string | undefined {
  if (target === "claude") return global ? join(home, ".claude", "skills") : join(cwd, ".claude", "skills");
  if (target === "codex") return global ? join(env.CODEX_HOME ?? join(home, ".codex"), "skills") : join(cwd, ".agents", "skills");
  return global ? undefined : join(cwd, ".cursor", "rules");
}

export function installSkills(opts: InstallOptions): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const dryRun = !!opts.dryRun;
  const skills = shippedSkills(opts.root);
  const lines: string[] = [];
  const files: InstallResult["files"] = [];
  if (!skills.length) return { lines: [`✗ Skills: none found in ${join(opts.root ?? packageRoot(), "skills")}.`], files };
  const show = (p: string) => (p.startsWith(cwd + sep) ? relative(cwd, p) : p.startsWith(home + sep) ? join("~", relative(home, p)) : p);
  const verb = (s: FileState) => (dryRun && s !== "unchanged" ? `would be ${s}` : s);

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
        state = put(shown, cursorRule(readFileSync(join(skill.dir, "SKILL.md"), "utf8")), dryRun);
        files.push({ path: shown, state });
      } else {
        shown = join(dir, skill.name);
        const states = skill.files.map((f) => {
          const path = join(shown, f);
          const s = put(path, readFileSync(join(skill.dir, f)), dryRun);
          files.push({ path, state: s });
          return s;
        });
        // The skill is new when its SKILL.md is; otherwise any change is an update.
        const main = states[skill.files.indexOf("SKILL.md")];
        state = main === "created" ? "created" : states.every((s) => s === "unchanged") ? "unchanged" : "updated";
      }
      lines.push(`${state === "unchanged" ? "✓" : "•"} ${LABEL[target]} skill ${skill.name}: ${verb(state)} (${show(shown)})`);
    }
  }
  return { lines, files };
}
