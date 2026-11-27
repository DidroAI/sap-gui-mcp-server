/**
 * `setup`: sets up the coding agents on this machine, as `npx skills add` does for skills:
 * it finds the agents (src/cli/agents.ts), the user picks (or every one found is taken), and
 * each one gets both parts:
 *
 * - the MCP server, in that agent's own config (`claude mcp add` for Claude Code, a TOML table
 *   for Codex, a JSON entry for most, a YAML entry for Goose);
 * - the skills, one real copy in ~/.agents/skills and a link to it in each other agent's folder
 *   (a copy where no link can be made).
 *
 * It never replaces an existing sap-ui-automation entry (with --extension it only adds
 * SAP_BROWSER=extension to its env, in a JSON or TOML file), keeps a .bak copy of a config file
 * it changes (the first one: a later run does not replace it), and with --dry-run only says
 * what it would do. A config it cannot read safely is left alone, with the entry to add by hand.
 *
 * The output is a short summary, the agents grouped by what they got; --verbose gives one line
 * per agent with its paths. What the user has to do by hand comes under "Needs your attention".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type InstallResult, installNativeHost, STORE_URL } from "../browser/extension/native.js";
import { type Agent, AGENT_IDS, AGENTS, type Ctx, detectAgents, type Env, type McpTarget, selectAgents, sharedSkills } from "./agents.js";
import { addToGoose, addToJson, type Edit, type EnvEdit, jsonEntry, NAME, OLD_NAMES, setJsonEnv } from "./mcp-config.js";
import { type Choice, multiSelect } from "./prompt.js";
import { type FolderResult, type SkillState, setupSharedSkills } from "./skills.js";
import { type Style, style } from "./style.js";

export { NAME, OLD_NAMES };
const PACKAGE = "sap-ui-automation";

/** The old names a JSON config holds under `key`. */
export function oldJsonEntries(text: string, key: string): string[] {
  try {
    const servers = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? OLD_NAMES.filter((n) => n in servers) : [];
  } catch {
    return [];
  }
}

/** The old names a Codex config.toml has a table for. */
export function oldCodexEntries(text: string): string[] {
  return OLD_NAMES.filter((n) => new RegExp(`^\\s*\\[mcp_servers\\.(?:${n}|"${n}"|'${n}')\\]`, "m").test(text));
}


function onPath(cmd: string, platform: NodeJS.Platform): boolean {
  const r = spawnSync(platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** How MCP clients should start this server, as it is installed here. */
export function launchCommand(argv1: string, platform: NodeJS.Platform, installedOnPath: boolean, execPath: string): string[] {
  const viaNpx = /[\\/]_npx[\\/]/.test(argv1);
  if (viaNpx) return platform === "win32" ? ["cmd", "/c", "npx", "-y", PACKAGE] : ["npx", "-y", PACKAGE];
  if (installedOnPath) return platform === "win32" ? ["cmd", "/c", PACKAGE] : [PACKAGE];
  return [execPath, argv1];
}

/** The TOML table Codex reads. */
export function codexTable(command: string[], env: Record<string, string> = {}): string {
  const q = (s: string) => JSON.stringify(s);
  const vars = Object.entries(env);
  const envLine = vars.length ? `env = { ${vars.map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }\n` : "";
  return `\n[mcp_servers.${NAME}]\ncommand = ${q(command[0] ?? "")}\nargs = [${command.slice(1).map(q).join(", ")}]\n${envLine}`;
}

/**
 * Whether Codex's config.toml already has this server: "yes" for a
 * `[mcp_servers.<name>]` table (bare or quoted key, or one of its sub-tables)
 * or an inline `<name> = {...}` entry; "unsure" when the name appears in some
 * other form, where appending a table could make the file invalid.
 */
export function codexHas(text: string): "yes" | "no" | "unsure" {
  const key = `(?:${NAME}|"${NAME}"|'${NAME}')`;
  // [mcp_servers.<name>], [mcp_servers."<name>"], [mcp_servers.<name>.env], [ mcp_servers . <name> ]
  if (new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${key}\\s*[.\\]]`, "m").test(text)) return "yes";
  // mcp_servers.<name> = {...}, <name> = {...} under [mcp_servers], or inside an inline mcp_servers table
  if (new RegExp(`(?:^|[\\s{,.])${key}\\s*=`, "m").test(text)) return "yes";
  return text.includes(NAME) ? "unsure" : "no";
}

/**
 * One argument for a cmd.exe command line, as cross-spawn does it: quoted for
 * the program's own argument parser, then every cmd metacharacter escaped with
 * ^ (twice for a .cmd/.bat shim, whose %* is read by cmd once more).
 */
export function cmdArg(arg: string, shim: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  a = a.replace(meta, "^$1");
  return shim ? a.replace(meta, "^$1") : a;
}

/** The command line cmd.exe runs for `file args...` (file is a resolved path). */
export function cmdLine(file: string, args: string[]): string {
  const shim = /\.(cmd|bat)$/i.test(file);
  return [file.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1"), ...args.map((a) => cmdArg(a, shim))].join(" ");
}

/**
 * Runs the claude command. On Windows it is a claude.exe, run directly, or an
 * npm claude.cmd shim, which needs cmd.exe: its arguments are then quoted for
 * cmd, so a path with a space or an & stays one argument.
 */
function runClaude(args: string[], platform: NodeJS.Platform, cwd: string) {
  if (platform !== "win32") return spawnSync("claude", args, { encoding: "utf8", cwd });
  const found = spawnSync("where", ["claude"], { encoding: "utf8" }).stdout ?? "";
  const file = found.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd|bat)$/i.test(l));
  if (!file) return spawnSync("claude", args, { encoding: "utf8", cwd });
  if (/\.exe$/i.test(file)) return spawnSync(file, args, { encoding: "utf8", cwd });
  return spawnSync(cmdLine(file, args), { encoding: "utf8", cwd, shell: true });
}

/** Keeps a copy of the file as it was before setup first changed it. */
function backup(file: string): void {
  if (existsSync(file) && !existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`);
}

/** Writes through a temporary file and a rename, so a crash never leaves half a config. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  backup(file);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface SetupResult {
  lines: string[];
  changed: number;
}

type RunClaude = (args: string[]) => { status: number | null; stdout?: string; stderr?: string };

export interface SetupOptions {
  dryRun: boolean;
  /** These agents (ids from src/cli/agents.ts), found or not. Empty or absent: every agent found. */
  only?: string[];
  /** The project folder for project-scoped configs (Cursor, VS Code). Default: process.cwd(). */
  cwd?: string | undefined;
  /** Whether a command is on PATH (tests replace it). */
  onPath?: ((cmd: string) => boolean) | undefined;
  /**
   * Through the Chrome extension: new entries get SAP_BROWSER=extension, and so does an existing
   * entry of ours in a JSON or TOML file; the extension's helper is installed too.
   */
  extension?: boolean | undefined;
  /** One line per agent, with its config file and skills folder (today's detail), instead of the grouped summary. */
  verbose?: boolean | undefined;
  /** Colour the marks and the secondary text. */
  color?: boolean | undefined;
  /** Install the bundled skills for the agents set up. Default: true. */
  skills?: boolean | undefined;
  /** Add the MCP server. Default: true; false: the skills only. */
  mcp?: boolean | undefined;
  /** Where the skills come from (tests). Default: this package. */
  skillsRoot?: string | undefined;
  /** With extension: installs the extension's helper (tests replace it). */
  installHelper?: (() => InstallResult) | undefined;
  /** Runs `claude` (tests replace it). */
  claude?: RunClaude | undefined;
  /** Makes a skill link (tests make it fail). */
  link?: ((target: string, path: string) => void) | undefined;
}

/** Every agent id setup knows. */
export const CLIENTS = AGENT_IDS;
export type Client = string;

/** The agents this machine (and project) has, without changing anything. */
export function detectClients(opts: { cwd?: string | undefined; onPath?: ((cmd: string) => boolean) | undefined } = {}, env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  return detectAgents(context({ ...opts }, env, platform, home));
}

function context(opts: { cwd?: string | undefined; onPath?: ((cmd: string) => boolean) | undefined }, env: Env, platform: NodeJS.Platform, home: string): Ctx {
  return { home, env, platform, cwd: opts.cwd ?? process.cwd(), has: opts.onPath ?? ((c: string) => onPath(c, platform)) };
}

/** An entry under one of this server's names before 0.1.0, and how to remove it. */
interface OldEntry {
  name: string;
  how: string;
}

/** What happened to one agent's server entry. */
interface McpOutcome {
  /** added: written now; present: there already; switched: SAP_BROWSER=extension added to it; would*: dry run; failed: not written (see text). */
  status: "added" | "present" | "switched" | "would" | "would-switch" | "failed";
  /** The agent's line under --verbose; for a failure, what went wrong and what to do. */
  text: string;
  /** Lines under it: an entry or table to add by hand, the table a dry run would add. */
  more: string[];
  old: OldEntry[];
  /** The entry is there without SAP_BROWSER=extension and setup did not add it: what to do. */
  env?: string | undefined;
}

/**
 * Adds `vars` to the env of Codex's `[mcp_servers.sap-ui-automation]` table: into its
 * `[mcp_servers.sap-ui-automation.env]` sub-table, its one-line `env = { ... }`, or as a new
 * `env = { ... }` line at the end of the table. Every other line stays as it is; a form other
 * than these (an inline entry, a multi-line or dotted env) is an error, left to the user.
 */
export function codexSetEnv(text: string, vars: Record<string, string>): EnvEdit {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const key = `(?:${NAME}|"${NAME}"|'${NAME}')`;
  const header = (sub: string) => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${key}${sub}\\s*\\]\\s*(?:#.*)?$`);
  const end = (start: number) => {
    let i = start + 1;
    while (i < lines.length && !/^\s*\[/.test(lines[i] ?? "")) i++;
    return i;
  };
  // The last line of the table that holds something: a new line goes right after it.
  const last = (start: number, stop: number) => {
    let i = stop - 1;
    while (i > start && !(lines[i] ?? "").trim()) i--;
    return i;
  };
  const str = `("(?:[^"\\\\]|\\\\.)*"|'[^']*')`;
  const unquote = (v: string) => (v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1));
  const bare = (k: string) => k.replace(/^["']|["']$/g, "");
  const check = (have: Map<string, string>): EnvEdit | [string, string][] => {
    for (const [k, v] of Object.entries(vars)) {
      const h = have.get(k);
      if (h !== undefined && h !== v) return { kind: "conflict", key: k, value: h };
    }
    const missing = Object.entries(vars).filter(([k]) => !have.has(k));
    return missing.length ? missing : { kind: "same" };
  };
  const pair = ([k, v]: [string, string]) => `${k} = ${JSON.stringify(v)}`;

  const sub = lines.findIndex((l) => header("\\s*\\.\\s*env").test(l));
  if (sub >= 0) {
    const stop = end(sub);
    const have = new Map<string, string>();
    for (const l of lines.slice(sub + 1, stop)) {
      const m = new RegExp(`^\\s*([A-Za-z0-9_-]+|"[^"]*")\\s*=\\s*(.*?)\\s*$`).exec(l);
      if (!m) continue;
      const v = new RegExp(`^${str}\\s*(?:#.*)?$`).exec(m[2] ?? "");
      have.set(bare(m[1] ?? ""), v ? unquote(v[1] ?? "") : (m[2] ?? ""));
    }
    const r = check(have);
    if (!Array.isArray(r)) return r;
    lines.splice(last(sub, stop) + 1, 0, ...r.map(pair));
    return { kind: "set", text: lines.join(eol) };
  }
  const main = lines.findIndex((l) => header("").test(l));
  if (main < 0) return { kind: "error", reason: `has "${NAME}" in a form setup does not change` };
  const stop = end(main);
  const body = lines.slice(main + 1, stop);
  if (body.some((l) => /^\s*env\s*\./.test(l))) return { kind: "error", reason: "has its env in dotted keys" };
  const at = body.findIndex((l) => /^\s*env\s*=/.test(l));
  if (at < 0) {
    const r = check(new Map());
    if (!Array.isArray(r)) return r;
    lines.splice(last(main, stop) + 1, 0, `env = { ${r.map(pair).join(", ")} }`);
    return { kind: "set", text: lines.join(eol) };
  }
  const m = /^(\s*env\s*=\s*\{)(.*)\}(\s*(?:#.*)?)$/.exec(body[at] ?? "");
  const inner = m?.[2] ?? "";
  if (!m || /[{}\n]/.test(inner)) return { kind: "error", reason: "has an env setup does not read" };
  const have = new Map<string, string>();
  for (const p of inner.matchAll(new RegExp(`([A-Za-z0-9_-]+|"[^"]*")\\s*=\\s*(${str.slice(1, -1)}|[^,]+)`, "g"))) {
    const v = (p[2] ?? "").trim();
    have.set(bare(p[1] ?? ""), /^["']/.test(v) ? unquote(v) : v);
  }
  const r = check(have);
  if (!Array.isArray(r)) return r;
  const kept = inner.trim().replace(/,$/, "");
  lines[main + 1 + at] = `${m[1]} ${[...(kept ? [kept] : []), ...r.map(pair)].join(", ")} }${m[3]}`;
  return { kind: "set", text: lines.join(eol) };
}

/** What `claude mcp get <name>` says about a stdio server: its command, args, env and how to remove it. */
export function claudeEntry(out: string): { command: string; args: string[]; env: Record<string, string>; remove?: string | undefined } | undefined {
  const command = /^\s*Command:\s*(.+?)\s*$/m.exec(out)?.[1];
  if (!command) return undefined;
  const args = (/^\s*Args:\s*(.*?)\s*$/m.exec(out)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const env: Record<string, string> = {};
  const block = /^\s*Environment:\s*\r?\n((?:[ \t]{3,}\S.*(?:\r?\n|$))*)/m.exec(out)?.[1] ?? "";
  for (const l of block.split(/\r?\n/)) {
    const m = /^\s*([^=\s]+)=(.*?)\s*$/.exec(l);
    if (m) env[m[1] as string] = m[2] ?? "";
  }
  const remove = /To remove this server, run:\s*(claude mcp remove .+?)\s*$/m.exec(out)?.[1];
  return { command, args, env, remove };
}

/** One word for a shell command line: as it is when plain, else quoted. */
function shellWord(s: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  // Windows (PowerShell, cmd): double quotes, a quote inside doubled. Elsewhere: single quotes, a quote inside closed and reopened.
  return platform === "win32" ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Claude Code's entry lacks SAP_BROWSER=extension. `claude mcp` cannot change an entry, and what
 * `claude mcp get` prints is not enough to re-add it faithfully (an argument with a space reads as
 * two), so setup does not re-add it: it gives the command, with the entry's own env kept.
 */
function claudeEnvFix(info: ReturnType<typeof claudeEntry>, vars: Record<string, string>, platform: NodeJS.Platform): string {
  if (!info) return `check its env with claude mcp get ${NAME}; without SAP_BROWSER=extension, run claude mcp remove ${NAME}, then setup --extension again`;
  const q = (s: string) => shellWord(s, platform);
  const scope = /\s(?:-s|--scope)\s+(\w+)/.exec(info.remove ?? "")?.[1] ?? "user";
  const env = Object.entries({ ...info.env, ...vars }).flatMap(([k, v]) => ["-e", q(`${k}=${v}`)]);
  const add = ["claude", "mcp", "add", NAME, "--scope", scope, ...env, "--", q(info.command), ...info.args.map(q)].join(" ");
  return `re-add it with SAP_BROWSER=extension: ${info.remove ?? `claude mcp remove ${NAME} -s ${scope}`} && ${add}`;
}

/** Writes (or would write) the server into one agent's config. */
function installMcp(target: McpTarget, command: string[], vars: Record<string, string>, opts: SetupOptions, show: (p: string) => string, platform: NodeJS.Platform, home: string): McpOutcome {
  const write = (file: string, text: string, what: string, would: string): McpOutcome => {
    if (opts.dryRun) return { status: "would-switch", text: `${would} ${show(file)}`, more: [], old: [] };
    writeAtomic(file, text);
    return { status: "switched", text: `${what} ${show(file)}`, more: [], old: [] };
  };
  const switched = "SAP_BROWSER=extension added to its entry in";
  const wouldSwitch = "would add SAP_BROWSER=extension to its entry in";

  if (target.kind === "claude") {
    const run: RunClaude = opts.claude ?? ((args) => runClaude(args, platform, home));
    const envArgs = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const old = OLD_NAMES.filter((n) => run(["mcp", "get", n]).status === 0).map((n) => ({ name: n, how: `claude mcp remove ${n}` }));
    // From the home folder: a project's own .mcp.json must not count as installed.
    const got = run(["mcp", "get", NAME]);
    if (got.status === 0) {
      const info = claudeEntry(got.stdout ?? "");
      const lacks = Object.entries(vars).some(([k, v]) => info?.env[k] !== v);
      return { status: "present", text: `server already configured (claude mcp get ${NAME})`, more: [], old, env: lacks ? claudeEnvFix(info, vars, platform) : undefined };
    }
    const args = ["mcp", "add", NAME, "--scope", "user", ...envArgs, "--", ...command];
    if (opts.dryRun) return { status: "would", text: `would run claude ${args.join(" ")}`, more: [], old };
    const r = run(args);
    if (r.status === 0) return { status: "added", text: "server added for your user", more: [], old };
    return { status: "failed", text: `claude mcp add failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`, more: [], old };
  }

  if (target.kind === "toml") {
    const file = target.file;
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const old = oldCodexEntries(text).map((n) => ({ name: n, how: `codex mcp remove ${n}` }));
    const present = codexHas(text);
    const table = codexTable(command, vars);
    if (present === "yes") {
      const e = Object.keys(vars).length ? codexSetEnv(text, vars) : ({ kind: "same" } as const);
      if (e.kind === "set") return { ...write(file, e.text, switched, wouldSwitch), old };
      const env =
        e.kind === "conflict"
          ? `its entry sets ${e.key}="${e.value}"; set it to "${vars[e.key]}" in ${show(file)}`
          : e.kind === "error"
            ? `${show(file)} ${e.reason}; add ${Object.entries(vars).map(([k, v]) => `${k} = "${v}"`).join(", ")} to its env by hand`
            : undefined;
      return { status: "present", text: `server already in ${show(file)}`, more: [], old, env };
    }
    if (present === "unsure") return { status: "failed", text: `${show(file)} names "${NAME}" in a form setup does not read; check it, or add this table by hand:`, more: table.trim().split("\n").map((l) => `    ${l}`), old };
    if (opts.dryRun) return { status: "would", text: `would add the server to ${show(file)}`, more: table.trim().split("\n").map((l) => `    ${l}`), old };
    writeAtomic(file, text + table);
    return { status: "added", text: `server added to ${show(file)}`, more: [], old };
  }

  const file = target.file;
  let text: string;
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (e) {
    return { status: "failed", text: `cannot read ${show(file)}: ${(e as Error).message}`, more: [], old: [] };
  }
  let edit: Edit;
  let byHand: string;
  const envKey = target.kind === "yaml" ? "envs" : target.shape === "opencode" ? "environment" : "env";
  if (target.kind === "yaml") {
    edit = addToGoose(text, command, vars);
    byHand = "add it under extensions: by hand (https://goose-docs.ai/docs/guides/config-files)";
  } else {
    const entry = jsonEntry(target.shape, command, vars);
    const opencode = target.shape === "opencode";
    edit = addToJson(text, target.key, entry, target.comments, { envKey, opencode });
    byHand = `add this under ${target.key.map((k) => `"${k}"`).join(" → ")} by hand: "${NAME}": ${JSON.stringify(entry)}`;
  }
  if (edit.kind === "error") return { status: "failed", text: `${show(file)} ${edit.reason}; ${byHand}`, more: [], old: [] };
  const where = target.kind === "yaml" ? "extensions" : (target.key.at(-1) ?? "mcpServers");
  const old = edit.old.map((n) => ({ name: n, how: `delete "${n}" under "${where}" in ${show(file)}` }));
  if (edit.kind === "present") {
    let env: string | undefined;
    if (edit.missingEnv.length) {
      const wanted = Object.fromEntries(edit.missingEnv);
      const e = target.kind === "json" ? setJsonEnv(text, target.key, wanted, target.comments, { envKey, opencode: target.shape === "opencode" }) : undefined;
      if (e?.kind === "set") return { ...write(file, e.text, switched, wouldSwitch), old };
      const add = target.kind === "yaml" ? edit.missingEnv.map(([k, v]) => `${k}: ${v}`).join(", ") : edit.missingEnv.map(([k, v]) => `"${k}": "${v}"`).join(", ");
      env =
        e?.kind === "conflict"
          ? `its entry sets ${e.key}="${e.value}"; set it to "${wanted[e.key]}" in ${show(file)}`
          : e?.kind === "error"
            ? `${show(file)} ${e.reason}; add ${add} to its "${envKey}" by hand`
            : `add ${add} under ${envKey} in ${show(file)}`;
    }
    return { status: "present", text: `server already in ${show(file)}`, more: [], old, env };
  }
  if (opts.dryRun) return { status: "would", text: `would add the server to ${show(file)}`, more: [], old };
  writeAtomic(file, edit.text);
  return { status: "added", text: `server added to ${show(file)}`, more: [], old };
}

/** The skills part of an agent's line, from what was done in its folder. */
function skillsText(r: FolderResult, canonical: string, show: (p: string) => string, dryRun: boolean): string {
  const by = new Map<SkillState, string[]>();
  for (const [name, state] of Object.entries(r.states)) by.set(state, [...(by.get(state) ?? []), name]);
  const all = Object.keys(r.states).length;
  const phrase = (state: SkillState, names: string[]): string => {
    const which = names.length === all ? "skills" : `skill${names.length > 1 ? "s" : ""} ${names.join(", ")}`;
    const dir = show(r.dir);
    const linked = r.canonical ? "" : " (linked)";
    if (state === "left") return `${which} in ${dir} not from this package, left as ${names.length > 1 ? "they are" : "it is"}`;
    if (state === "linked") return `${which} ${dryRun ? "would be linked" : "linked"} in ${dir} → ${show(canonical)}`;
    if (state === "copied") return `${which} copied to ${dir} (a link could not be made there)`;
    if (state === "unchanged") return `${which} up to date in ${dir}${linked}`;
    return `${which} ${dryRun ? "would be " : ""}${state} in ${dir}${linked}`;
  };
  return [...by.entries()].map(([s, n]) => phrase(s, n)).join("; ");
}

/** One agent's part in the run. */
interface Row {
  agent: Agent;
  m?: McpOutcome | undefined;
  /** Its skills folder, as set up; absent: no skills for it. */
  folder?: FolderResult | undefined;
  skillsChanged: boolean;
}

/** The extension's helper. */
type Helper = { status: "ok"; count: number } | { status: "would" } | { status: "failed"; text: string } | undefined;

/** Names, as many as fit in `width` characters, then "… (n)". */
export function fitNames(names: string[], width: number): string {
  const all = names.join(", ");
  if (all.length <= width) return all;
  const more = (shown: number) => `, … (${names.length})`.length + (shown ? 0 : -2);
  let out = "";
  let shown = 0;
  for (const n of names) {
    const next = out ? `${out}, ${n}` : n;
    if (next.length + more(shown + 1) > width) break;
    out = next;
    shown++;
  }
  return shown ? `${out}, … (${names.length})` : `${names.length} agents`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const andList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));
/** How each agent that needs more than a restart loads a new server, for the first "Next" step. */
const RELOAD: Record<string, string> = {
  codex: "a new Codex session",
  "claude-desktop": "quit and reopen Claude Desktop",
  cursor: "reload MCP servers",
  windsurf: "reload MCP servers",
  vscode: "start it from the MCP view",
};

export function setup(opts: SetupOptions, env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): SetupResult {
  const argv1 = (() => {
    try {
      return realpathSync(process.argv[1] ?? "");
    } catch {
      return process.argv[1] ?? "";
    }
  })();
  const ctx = context(opts, env, platform, home);
  const command = launchCommand(argv1, platform, ctx.has(PACKAGE), process.execPath);
  const ids = opts.only?.length ? opts.only : detectAgents(ctx);
  const agents = AGENTS.filter((a) => ids.includes(a.id));
  const show = (p: string) => (p.startsWith(home + sep) ? join("~", relative(home, p)) : p);
  // --extension: the server reaches Chrome through the extension. New entries get it, and so do
  // existing entries of ours in a JSON or TOML file; the others are named under "Needs your attention".
  const vars: Record<string, string> = opts.extension ? { SAP_BROWSER: "extension" } : {};
  const withMcp = opts.mcp !== false;
  const withSkills = opts.skills !== false;
  const dry = opts.dryRun;
  const s = style(!!opts.color);
  let changed = 0;

  // The server first: an agent whose entry could not be written gets no skills either.
  const mcp = new Map<string, McpOutcome | undefined>();
  for (const a of agents) {
    if (!withMcp || !a.mcp) continue;
    const target = a.mcp(ctx);
    if (!target) {
      mcp.set(a.id, { status: "failed", text: `no MCP config ${a.id === "claude-desktop" ? "on this system (Claude Desktop runs on macOS and Windows)" : `known on ${platform}`}`, more: [], old: [] });
      continue;
    }
    if (target.kind === "claude" && !ctx.has("claude")) {
      mcp.set(a.id, { status: "failed", text: `no claude command; once Claude Code is installed, run: claude mcp add ${NAME} --scope user -- ${command.join(" ")}`, more: [], old: [] });
      continue;
    }
    try {
      mcp.set(a.id, installMcp(target, command, vars, opts, show, platform, home));
    } catch (e) {
      mcp.set(a.id, { status: "failed", text: `could not write its config: ${(e as Error).message}`, more: [], old: [] });
    }
  }

  // The skills, where each agent that has the server reads them: one copy in ~/.agents/skills, links elsewhere.
  const canonical = sharedSkills(ctx);
  const skillDir = new Map<string, string>();
  if (withSkills)
    for (const a of agents) {
      if (!a.skills || mcp.get(a.id)?.status === "failed") continue;
      skillDir.set(a.id, a.skills(ctx));
    }
  const folders = skillDir.size ? setupSharedSkills([...new Set(skillDir.values())], { canonical, dryRun: dry, platform, root: opts.skillsRoot, link: opts.link }) : [];

  const rows: Row[] = agents.map((a) => {
    const dir = skillDir.get(a.id);
    const folder = dir ? folders.find((x) => x.dir === dir) : undefined;
    const skillsChanged = !!folder && Object.values(folder.states).some((st) => st !== "unchanged" && st !== "left");
    return { agent: a, m: mcp.get(a.id), folder, skillsChanged };
  });
  for (const r of rows) if (r.m?.status === "added" || r.m?.status === "switched") changed++;
  const restart = dry ? [] : rows.filter((r) => r.m?.status === "added" || r.m?.status === "switched" || r.skillsChanged).map((r) => r.agent);

  // --extension: the helper too, so that one command sets everything up (the extension pairs in one click and
  // keeps saved SAP passwords in the keychain). Running it again replaces the helper with this version's.
  let helper: Helper;
  if (opts.extension) {
    if (dry) helper = { status: "would" };
    else {
      try {
        const host = (opts.installHelper ?? (() => installNativeHost({ home, env })))();
        helper = host.registered.length ? { status: "ok", count: host.registered.length } : { status: "failed", text: `copied to ${host.hostDir}, but no browser profile folder took it (is Chrome installed?). Pair by hand: npx -y ${PACKAGE} extension pair` };
      } catch (e) {
        helper = { status: "failed", text: `${(e as Error).message}. Pair by hand: npx -y ${PACKAGE} extension pair` };
      }
    }
  }

  const lines = opts.verbose ? detailLines(rows, helper, { command, withMcp, withSkills, dry, canonical, show, s }) : summaryLines(rows, folders, helper, { withMcp, withSkills, dry, canonical, show, s });
  if (!agents.length)
    lines.push(
      `No agent found. Name one: npx -y ${PACKAGE} setup --agent <id> (${AGENT_IDS.join(", ")}),`,
      `or add this command to your agent's MCP settings by hand: ${command.join(" ")}`,
      `Skills for other agents: npx skills add DidroAI/sap-ui-mcp`,
    );
  lines.push(...attentionLines(rows, folders, helper, { show, s }));
  lines.push(...nextLines(restart, helper, { extension: !!opts.extension, dry, s }));
  return { lines, changed };
}

interface Render {
  withMcp: boolean;
  withSkills: boolean;
  dry: boolean;
  canonical: string;
  show: (p: string) => string;
  s: Style;
}

/** --verbose: one line per agent, with its config file and skills folder. */
function detailLines(rows: Row[], helper: Helper, o: Render & { command: string[] }): string[] {
  const { s, dry, show } = o;
  const lines: string[] = o.withMcp ? [`Command for MCP clients: ${o.command.join(" ")}`, ""] : [];
  const reported = new Set<string[]>();
  for (const { agent: a, m, folder } of rows) {
    const parts: string[] = [];
    if (m) parts.push(m.text);
    const more = [...(m?.more ?? [])];
    if (folder) {
      parts.push(skillsText(folder, o.canonical, show, dry));
      if (folder.removed.length && !reported.has(folder.removed)) {
        more.push(s.dim(`  ${dry ? "Would remove" : "Removed"} the skills' old names ${folder.removed.join(", ")} in ${show(folder.dir)}.`));
        reported.add(folder.removed);
      }
    } else if (o.withSkills && !a.skills && m && m.status !== "failed") parts.push("it reads no skills from disk");
    if (!parts.length) parts.push(`skipped (${skipReason(a, o)})`);
    const mark = m?.status === "failed" ? s.red("✗") : !m && !folder ? "–" : dry ? "•" : s.green("✓");
    lines.push(`${mark} ${a.name}: ${parts.join("; ")}.`, ...more);
  }
  if (helper?.status === "would") lines.push("• Chrome extension helper: would install it, for the extension to pair in one click.");
  if (helper?.status === "ok") lines.push(`${s.green("✓")} Chrome extension helper: installed (${helper.count} browser profile folder(s)).`);
  if (helper?.status === "failed") lines.push(`${s.red("✗")} Chrome extension helper: ${helper.text}.`);
  return lines;
}

function skipReason(a: Agent, o: { withMcp: boolean; withSkills: boolean }): string {
  const why = [!o.withMcp ? "--no-mcp" : !a.mcp ? "no MCP config known" : "", !o.withSkills ? "--no-skills" : !a.skills ? "it reads no skills from disk" : ""];
  return why.filter(Boolean).join(", ");
}

/** The default: the agents grouped by what they got, counts instead of paths. */
function summaryLines(rows: Row[], folders: FolderResult[], helper: Helper, o: Render): string[] {
  const { s, dry, show } = o;
  const LABEL = 17;
  const name = (r: Row) => r.agent.short ?? r.agent.name;
  const ok = (r: Row) => !!r.m && r.m.status !== "failed";
  const group = (mark: string, label: string, list: Row[], extra = (r: Row) => name(r)) => (list.length ? [`${mark} ${label.padEnd(LABEL)}  ${fitNames(list.map(extra), 72)}`] : []);
  const note = (text: string) => s.dim(`  ${text}`);
  const tick = dry ? "•" : s.green("✓");
  const lines: string[] = dry ? [s.dim("Dry run: nothing is written. Setup would do this:"), ""] : [];
  const failed = rows.filter((r) => r.m?.status === "failed");
  lines.push(
    ...group(tick, "Server and skills", rows.filter((r) => ok(r) && r.folder)),
    ...group(tick, "Server only", rows.filter((r) => ok(r) && !r.folder)),
    ...group(tick, "Skills only", rows.filter((r) => !r.m && r.folder)),
    ...group(s.red("✗"), "Not set up", failed),
    ...group("–", "Skipped", rows.filter((r) => !r.m && !r.folder), (r) => `${name(r)} (${skipReason(r.agent, o)})`),
  );

  // The server: how many entries were added, were there, were switched to the extension.
  const count = (st: McpOutcome["status"][]) => rows.filter((r) => r.m && st.includes(r.m.status));
  const added = count(["added", "would"]).length;
  const there = count(["present"]).length;
  const switched = count(["switched", "would-switch"]).map(name);
  const server = [
    added ? `${dry ? "would be added" : "added"} for ${plural(added, "agent")}` : "",
    there ? `already there for ${there}` : "",
    switched.length ? `${dry ? "would be switched" : "switched"} to the extension for ${andList(switched)}` : "",
  ].filter(Boolean);
  if (server.length) lines.push(note(`Server ${server.join(", ")}`));

  // The skills: the one copy, and how the other folders reach it.
  const top = folders[0];
  if (top) {
    const states = Object.values(top.states);
    const word = states.includes("installed") ? "installed" : states.includes("updated") ? "updated" : states.every((x) => x === "left") ? "" : "up to date";
    const how = { linked: 0, copied: 0, own: 0 };
    for (const r of rows) {
      const f = r.folder;
      if (!f || f.canonical) continue;
      const st = Object.entries(f.states).filter(([, x]) => x !== "left");
      if (!st.length) continue;
      if (st.some(([, x]) => x === "copied")) how.copied++;
      else if (st.some(([k]) => top.states[k] === "left")) how.own++;
      else how.linked++;
    }
    const each = [how.linked ? `linked for ${plural(how.linked, "agent")}` : "", how.copied ? `copied for ${how.copied} (no link possible)` : "", how.own ? `a copy of their own for ${how.own}` : ""].filter(Boolean);
    const verb = word === "up to date" || !word ? word : dry ? `would be ${word}` : word;
    if (verb || each.length) lines.push(note(`Skills ${verb ? `${verb} ` : ""}in ${show(top.dir)}${each.length ? `, ${each.join(", ")}` : ""}`));
    const removed = folders.filter((f, i) => f.removed.length && folders.findIndex((g) => g.removed === f.removed) === i);
    if (removed.length) {
      const names = [...new Set(removed.flatMap((f) => f.removed))];
      lines.push(note(`${dry ? "Would remove" : "Removed"} the skills' old names (${names.join(", ")}) in ${plural(removed.length, "folder")}`));
    }
  }

  if (helper?.status === "ok") lines.push(`${s.green("✓")} ${"Chrome helper".padEnd(LABEL)}  installed`);
  if (helper?.status === "would") lines.push(`• ${"Chrome helper".padEnd(LABEL)}  would be installed`);
  if (helper?.status === "failed") lines.push(`${s.red("✗")} ${"Chrome helper".padEnd(LABEL)}  not installed`);
  return lines;
}

/** What the user has to do by hand: one entry per issue, the agents under it. */
function attentionLines(rows: Row[], folders: FolderResult[], helper: Helper, o: { show: (p: string) => string; s: Style }): string[] {
  const { s, show } = o;
  const warn = s.yellow("!");
  const out: string[] = [];
  const item = (mark: string, head: string, sub: string[]) => out.push(`${mark} ${head}`, ...sub.map((l) => `    ${l}`));
  const name = (r: Row) => r.agent.short ?? r.agent.name;

  const failed = rows.filter((r) => r.m?.status === "failed");
  for (const r of failed) item(s.red("✗"), `${r.agent.name}: ${r.m?.text}`, (r.m?.more ?? []).map((l) => l.trim()));
  if (helper?.status === "failed") item(s.red("✗"), `Chrome helper: ${helper.text}`, []);

  for (const old of OLD_NAMES) {
    const have = rows.flatMap((r) => (r.m?.old ?? []).filter((e) => e.name === old).map((e) => `${name(r)}: ${e.how}`));
    if (have.length) item(warn, `"${old}", this server's name before 0.1.0, is still there: the agent gets its tools twice. Remove it:`, have);
  }
  const env = rows.filter((r) => r.m?.env);
  if (env.length) item(warn, "Entries without SAP_BROWSER=extension that setup does not change:", env.map((r) => `${name(r)}: ${r.m?.env}`));

  // A skill folder of the same name that is not this package's: left as it is.
  const left = folders
    .filter((f, i) => folders.findIndex((g) => g.dir === f.dir) === i)
    .flatMap((f) => {
      const names = Object.entries(f.states).filter(([, x]) => x === "left").map(([k]) => k);
      return names.length ? [`${show(f.dir)}: ${names.join(", ")}`] : [];
    });
  if (left.length) item(warn, "Skills of the same name not from this package, left as they are:", left);
  return out.length ? ["", s.bold("Needs your attention"), ...out] : [];
}

/** Short numbered steps. */
function nextLines(restart: Agent[], helper: Helper, o: { extension: boolean; dry: boolean; s: Style }): string[] {
  const steps: string[] = [];
  if (o.dry) steps.push("Run it again without --dry-run to make these changes.");
  else {
    if (restart.length) {
      const ids = restart.map((a) => a.id);
      const reload = restart.filter((a) => RELOAD[a.id] === "reload MCP servers").map((a) => a.short ?? a.name);
      const special = [
        ...(ids.includes("codex") ? [RELOAD.codex as string] : []),
        ...(reload.length ? [`${andList(reload)}: reload MCP servers`] : []),
        ...(ids.includes("claude-desktop") ? [RELOAD["claude-desktop"] as string] : []),
        ...(ids.includes("vscode") ? [`VS Code: ${RELOAD.vscode}`] : []),
      ];
      steps.push(`Restart your agent apps${special.length ? ` (${special.join("; ")})` : ""}.`);
    }
    if (o.extension)
      steps.push(`In Chrome: add the extension (${STORE_URL}),${helper?.status === "ok" ? " restart Chrome," : ""} click its icon → Pair, add your SAP systems.`);
    steps.push(`Ask your agent to look at your SAP screen.${o.extension ? "" : " For Web GUI and Fiori, log on once in the Chrome window it opens."}`);
    steps.push(`Not working? npx -y ${PACKAGE} doctor`);
  }
  return ["", o.s.bold("Next"), ...steps.map((t, i) => `  ${i + 1}. ${t}`)];
}

// ---------------------------------------------------------------- the command: flags, detection, the picker

export interface SetupArgs {
  /** Agent ids: positional names and --agent/-a values (comma lists, repeated). */
  named: string[];
  dryRun: boolean;
  extension: boolean;
  skills: boolean;
  mcp: boolean;
  yes: boolean;
  verbose: boolean;
}

/** Reads `setup`'s arguments; an unknown option is an error. */
export function parseSetupArgs(args: string[]): SetupArgs | { error: string } {
  const r: SetupArgs = { named: [], dryRun: false, extension: false, skills: true, mcp: true, yes: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--dry-run") r.dryRun = true;
    else if (a === "--extension") r.extension = true;
    else if (a === "--no-skills") r.skills = false;
    else if (a === "--no-mcp") r.mcp = false;
    else if (a === "--yes" || a === "-y") r.yes = true;
    else if (a === "--verbose" || a === "-v") r.verbose = true;
    else if (a === "--agent" || a === "-a") {
      const v = args[++i];
      if (!v || v.startsWith("-")) return { error: `${a} needs agent ids, e.g. ${a} claude-code,codex (or '*' for every agent found).` };
      r.named.push(v);
    } else if (a.startsWith("--agent=")) r.named.push(a.slice(8));
    else if (a.startsWith("-") && a !== "*") return { error: `Unknown option ${a}. setup takes --agent <ids>, --yes, --dry-run, --verbose, --no-skills, --no-mcp, --extension.` };
    else r.named.push(a);
  }
  if (!r.mcp && !r.skills) return { error: "--no-mcp and --no-skills together leave nothing to do." };
  return r;
}

export interface SetupCommandIo {
  out: (line: string) => void;
  /** Stdin and stdout are a terminal: the picker may be shown. */
  tty: boolean;
  /** Colour the output (a terminal, NO_COLOR not set). Default: no colour. */
  color?: boolean | undefined;
  /** The picker (tests replace it): the ids ticked, or undefined when cancelled. */
  pick?: ((choices: Choice[], initial: string[]) => Promise<string[] | undefined>) | undefined;
  /** Passed through to setup (tests). */
  options?: Partial<SetupOptions>;
  env?: Env;
  platform?: NodeJS.Platform;
  home?: string;
}

/** The picker's list: the agents found first, then the others under "Not found"; "skills only" where there is no server. */
export function pickChoices(detected: string[]): Choice[] {
  const choice = (a: Agent, group?: string): Choice => ({ value: a.id, label: a.name, ...(a.mcp ? {} : { hint: "skills only" }), ...(group ? { group } : {}) });
  return [...AGENTS.filter((a) => detected.includes(a.id)).map((a) => choice(a)), ...AGENTS.filter((a) => !detected.includes(a.id)).map((a) => choice(a, "Not found"))];
}

/** `setup` from the command line: finds the agents, lets the user pick in a terminal, then sets each one up. */
export async function setupCommand(args: string[], io: SetupCommandIo): Promise<number> {
  const p = parseSetupArgs(args);
  if ("error" in p) {
    io.out(p.error);
    return 2;
  }
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const home = io.home ?? homedir();
  const color = !!io.color;
  const s = style(color);
  const ctx = context({ cwd: io.options?.cwd, onPath: io.options?.onPath }, env, platform, home);
  const detected = detectAgents(ctx);
  const names = (ids: string[]) => ids.map((id) => AGENTS.find((a) => a.id === id)?.name ?? id).join(", ");
  const sel = selectAgents(p.named, detected, io.tty && !p.yes);
  if ("error" in sel) {
    io.out(sel.error);
    return 2;
  }
  let ids: string[];
  if ("prompt" in sel) {
    const title = detected.length ? "Set up which agents?" : "No agent found. Set up which agents?";
    const picked = await (io.pick ?? ((c, i) => multiSelect(title, c, i, undefined, color)))(pickChoices(detected), sel.prompt);
    if (!picked) {
      io.out("Cancelled; nothing changed.");
      return 1;
    }
    if (!picked.length) {
      io.out("No agent selected; nothing changed.");
      return 0;
    }
    ids = picked;
    // The picker is gone from the screen: one line stands for it.
    io.out(`${s.green("✓")} ${plural(ids.length, "agent")} selected`);
  } else {
    ids = sel.ids;
    if (p.named.length) io.out(`Setting up: ${names(ids)}.`);
    else io.out(`Agents found: ${detected.length ? names(detected) : "none"}.`);
  }
  io.out("");
  const r = setup({ ...io.options, dryRun: p.dryRun, extension: p.extension, skills: p.skills, mcp: p.mcp, verbose: p.verbose, color, only: ids }, env, platform, home);
  for (const l of r.lines) io.out(l);
  return 0;
}
