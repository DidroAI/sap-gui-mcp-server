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
 * It never overwrites an existing sap-ui-automation entry, keeps a .bak copy of a config file
 * it changes (the first one: a later run does not replace it), and with --dry-run only says
 * what it would do. A config it cannot read safely is left alone, with the entry to add by hand.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type InstallResult, installNativeHost, STORE_URL } from "../browser/extension/native.js";
import { type Agent, AGENT_IDS, AGENTS, type Ctx, detectAgents, type Env, type McpTarget, selectAgents, sharedSkills } from "./agents.js";
import { addToGoose, addToJson, type Edit, jsonEntry, NAME, OLD_NAMES } from "./mcp-config.js";
import { multiSelect } from "./prompt.js";
import { type FolderResult, type SkillState, setupSharedSkills } from "./skills.js";

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

const oldLine = (name: string, how: string) => `  ! Also found "${name}", this server's name before 0.1.0: the agent gets its tools twice. Remove it: ${how}`;

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
  /** Through the Chrome extension: the new entries get SAP_BROWSER=extension. */
  extension?: boolean | undefined;
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

/** What happened to one agent's server entry. */
interface McpOutcome {
  /** added: written now; present: there already; would: dry run; failed: not written (see text). */
  status: "added" | "present" | "would" | "failed";
  text: string;
  /** Lines under the agent's line: by-hand entries, old names, env to add. */
  more: string[];
}

const envLine = (missing: [string, string][], key: string) => (missing.length ? [`  Add ${missing.map(([k, v]) => `"${k}": "${v}"`).join(", ")} to its "${key}".`] : []);

/** Writes (or would write) the server into one agent's config. */
function installMcp(target: McpTarget, command: string[], vars: Record<string, string>, opts: SetupOptions, show: (p: string) => string, platform: NodeJS.Platform, home: string): McpOutcome {
  if (target.kind === "claude") {
    const run: RunClaude = opts.claude ?? ((args) => runClaude(args, platform, home));
    const envArgs = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const old = OLD_NAMES.filter((n) => run(["mcp", "get", n]).status === 0).map((n) => oldLine(n, `claude mcp remove ${n}`));
    // From the home folder: a project's own .mcp.json must not count as installed.
    if (run(["mcp", "get", NAME]).status === 0) {
      return { status: "present", text: `server already configured (claude mcp get ${NAME})`, more: [...(opts.extension ? ["  If it does not have SAP_BROWSER=extension yet, add it to its env."] : []), ...old] };
    }
    const args = ["mcp", "add", NAME, "--scope", "user", ...envArgs, "--", ...command];
    if (opts.dryRun) return { status: "would", text: `would run claude ${args.join(" ")}`, more: old };
    const r = run(args);
    if (r.status === 0) return { status: "added", text: "server added for your user", more: old };
    return { status: "failed", text: `claude mcp add failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`, more: old };
  }

  if (target.kind === "toml") {
    const file = target.file;
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const old = oldCodexEntries(text).map((n) => oldLine(n, `codex mcp remove ${n}`));
    const present = codexHas(text);
    const table = codexTable(command, vars);
    if (present === "yes") return { status: "present", text: `server already in ${show(file)}`, more: [...(opts.extension ? ["  If it does not have SAP_BROWSER=extension yet, add it to its env."] : []), ...old] };
    if (present === "unsure") return { status: "failed", text: `${show(file)} names "${NAME}" in a form setup does not read; check it, or add this table by hand:`, more: [...table.trim().split("\n").map((l) => `    ${l}`), ...old] };
    if (opts.dryRun) return { status: "would", text: `would add the server to ${show(file)}`, more: [...table.trim().split("\n").map((l) => `    ${l}`), ...old] };
    writeAtomic(file, text + table);
    return { status: "added", text: `server added to ${show(file)}`, more: old };
  }

  const file = target.file;
  let text: string;
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (e) {
    return { status: "failed", text: `cannot read ${show(file)}: ${(e as Error).message}`, more: [] };
  }
  let edit: Edit;
  let byHand: string;
  if (target.kind === "yaml") {
    edit = addToGoose(text, command, vars);
    byHand = "add it under extensions: by hand (https://goose-docs.ai/docs/guides/config-files)";
  } else {
    const entry = jsonEntry(target.shape, command, vars);
    const opencode = target.shape === "opencode";
    edit = addToJson(text, target.key, entry, target.comments, { envKey: opencode ? "environment" : "env", opencode });
    byHand = `add this under ${target.key.map((k) => `"${k}"`).join(" → ")} by hand: "${NAME}": ${JSON.stringify(entry)}`;
  }
  if (edit.kind === "error") return { status: "failed", text: `${show(file)} ${edit.reason}; ${byHand}`, more: [] };
  const where = target.kind === "yaml" ? "extensions" : (target.key.at(-1) ?? "mcpServers");
  const old = edit.old.map((n) => oldLine(n, `delete "${n}" under "${where}" in ${show(file)}`));
  if (edit.kind === "present") return { status: "present", text: `server already in ${show(file)}`, more: [...envLine(edit.missingEnv, target.kind === "yaml" ? "envs" : target.kind === "json" && target.shape === "opencode" ? "environment" : "env"), ...old] };
  if (opts.dryRun) return { status: "would", text: `would add the server to ${show(file)}`, more: old };
  writeAtomic(file, edit.text);
  return { status: "added", text: `server added to ${show(file)}`, more: old };
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
  // --extension: the server reaches Chrome through the extension. Only new entries get it; an existing one is named.
  const vars: Record<string, string> = opts.extension ? { SAP_BROWSER: "extension" } : {};
  const withMcp = opts.mcp !== false;
  const withSkills = opts.skills !== false;
  const lines: string[] = withMcp ? [`Command for MCP clients: ${command.join(" ")}`, ""] : [];
  let changed = 0;

  // The server first: an agent whose entry could not be written gets no skills either.
  const mcp = new Map<string, McpOutcome | undefined>();
  for (const a of agents) {
    if (!withMcp || !a.mcp) continue;
    const target = a.mcp(ctx);
    if (!target) {
      mcp.set(a.id, { status: "failed", text: `no MCP config ${a.id === "claude-desktop" ? "on this system (Claude Desktop runs on macOS and Windows)" : `known on ${platform}`}`, more: [] });
      continue;
    }
    if (target.kind === "claude" && !ctx.has("claude")) {
      mcp.set(a.id, { status: "failed", text: `no claude command; once Claude Code is installed, run: claude mcp add ${NAME} --scope user -- ${command.join(" ")}`, more: [] });
      continue;
    }
    try {
      mcp.set(a.id, installMcp(target, command, vars, opts, show, platform, home));
    } catch (e) {
      mcp.set(a.id, { status: "failed", text: `could not write its config: ${(e as Error).message}`, more: [] });
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
  const folders = skillDir.size ? setupSharedSkills([...new Set(skillDir.values())], { canonical, dryRun: opts.dryRun, platform, root: opts.skillsRoot, link: opts.link }) : [];
  const reported = new Set<string[]>();

  const restart: Agent[] = [];
  for (const a of agents) {
    const m = mcp.get(a.id);
    const parts: string[] = [];
    if (m) parts.push(m.text);
    const dir = skillDir.get(a.id);
    let skillsChanged = false;
    let more = m?.more ?? [];
    if (dir) {
      const f = folders.find((x) => x.dir === dir);
      if (f) {
        parts.push(skillsText(f, canonical, show, opts.dryRun));
        if (Object.values(f.states).some((s) => s !== "unchanged" && s !== "left")) skillsChanged = true;
        if (f.removed.length && !reported.has(f.removed)) {
          more = [...more, `  ${opts.dryRun ? "Would remove" : "Removed"} the skills' old names ${f.removed.join(", ")} in ${show(f.dir)}.`];
          reported.add(f.removed);
        }
      }
    } else if (withSkills && !a.skills && m?.status !== "failed") parts.push("it reads no skills from disk");
    if (!parts.length) continue;
    const mark = m?.status === "failed" ? "✗" : opts.dryRun ? "•" : "✓";
    lines.push(`${mark} ${a.name}: ${parts.join("; ")}.`, ...more);
    if (m?.status === "added") changed++;
    if (!opts.dryRun && (m?.status === "added" || skillsChanged)) restart.push(a);
  }

  // --extension: the helper too, so that one command sets everything up (the extension pairs in one click and
  // keeps saved SAP passwords in the keychain). Running it again replaces the helper with this version's.
  let helperOk = false;
  if (opts.extension) {
    if (opts.dryRun) lines.push("• Chrome extension helper: would install it, for the extension to pair in one click.");
    else {
      try {
        const host = (opts.installHelper ?? (() => installNativeHost({ home, env })))();
        helperOk = host.registered.length > 0;
        lines.push(
          helperOk
            ? `✓ Chrome extension helper: installed (${host.registered.length} browser profile folder(s)).`
            : `✗ Chrome extension helper: copied to ${host.hostDir}, but no browser profile folder took it (is Chrome installed?). Pair by hand: npx -y sap-ui-automation extension pair.`,
        );
      } catch (e) {
        lines.push(`✗ Chrome extension helper: ${(e as Error).message}. Pair by hand: npx -y sap-ui-automation extension pair.`);
      }
    }
  }

  if (!agents.length)
    lines.push(
      `No agent found. Name one: npx -y ${PACKAGE} setup --agent <id> (${AGENT_IDS.join(", ")}),`,
      `or add this command to your agent's MCP settings by hand: ${command.join(" ")}`,
      `Skills for other agents: npx skills add DidroAI/sap-ui-automation`,
    );
  const plain = restart.filter((a) => !a.reload).map((a) => a.name);
  const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));
  const how = [...(plain.length ? [`restart ${and(plain)}`] : []), ...restart.flatMap((a) => (a.reload ? [a.reload] : []))];
  lines.push(
    "",
    how.length ? `Next: ${how.join("; ")} (a new session loads what changed), then ask your agent to look at your SAP screen.` : "Next: ask your agent to look at your SAP screen.",
    ...(opts.extension
      ? [
          `In Chrome: add UI Automation for SAP if you have not (${STORE_URL}),${helperOk ? " restart Chrome once," : ""} then click its icon and Pair in the side panel, and add your SAP systems there.`,
        ]
      : ["For Web GUI and Fiori, a Chrome window opens: open your SAP address there and log on, once."]),
    "If it cannot see SAP, run npx -y sap-ui-automation doctor.",
  );
  return { lines, changed };
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
}

/** Reads `setup`'s arguments; an unknown option is an error. */
export function parseSetupArgs(args: string[]): SetupArgs | { error: string } {
  const r: SetupArgs = { named: [], dryRun: false, extension: false, skills: true, mcp: true, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--dry-run") r.dryRun = true;
    else if (a === "--extension") r.extension = true;
    else if (a === "--no-skills") r.skills = false;
    else if (a === "--no-mcp") r.mcp = false;
    else if (a === "--yes" || a === "-y") r.yes = true;
    else if (a === "--agent" || a === "-a") {
      const v = args[++i];
      if (!v || v.startsWith("-")) return { error: `${a} needs agent ids, e.g. ${a} claude-code,codex (or '*' for every agent found).` };
      r.named.push(v);
    } else if (a.startsWith("--agent=")) r.named.push(a.slice(8));
    else if (a.startsWith("-") && a !== "*") return { error: `Unknown option ${a}. setup takes --agent <ids>, --yes, --dry-run, --no-skills, --no-mcp, --extension.` };
    else r.named.push(a);
  }
  if (!r.mcp && !r.skills) return { error: "--no-mcp and --no-skills together leave nothing to do." };
  return r;
}

export interface SetupCommandIo {
  out: (line: string) => void;
  /** Stdin and stdout are a terminal: the picker may be shown. */
  tty: boolean;
  /** The picker (tests replace it): the ids ticked, or undefined when cancelled. */
  pick?: ((choices: { value: string; label: string; hint?: string }[], initial: string[]) => Promise<string[] | undefined>) | undefined;
  /** Passed through to setup (tests). */
  options?: Partial<SetupOptions>;
  env?: Env;
  platform?: NodeJS.Platform;
  home?: string;
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
  const ctx = context({ cwd: io.options?.cwd, onPath: io.options?.onPath }, env, platform, home);
  const detected = detectAgents(ctx);
  const names = (ids: string[]) => ids.map((id) => AGENTS.find((a) => a.id === id)?.name ?? id).join(", ");
  io.out(`Agents found: ${detected.length ? names(detected) : "none"}.`);
  const sel = selectAgents(p.named, detected, io.tty && !p.yes);
  if ("error" in sel) {
    io.out(sel.error);
    return 2;
  }
  let ids: string[];
  if ("prompt" in sel) {
    const choices = AGENTS.map((a) => ({ value: a.id, label: a.name, hint: [detected.includes(a.id) ? "found" : "", a.mcp ? "" : "skills only"].filter(Boolean).join(", ") }));
    const picked = await (io.pick ?? ((c, i) => multiSelect(detected.length ? "Set up which agents?" : "No agent found. Set up which agents?", c, i)))(choices, sel.prompt);
    if (!picked) {
      io.out("Cancelled; nothing changed.");
      return 1;
    }
    if (!picked.length) {
      io.out("No agent selected; nothing changed.");
      return 0;
    }
    ids = picked;
  } else ids = sel.ids;
  // Nothing found and nothing named: setup's own lines say how to name one.
  if (ids.length) io.out(`Setting up: ${names(ids)}.`);
  io.out("");
  const r = setup({ ...io.options, dryRun: p.dryRun, extension: p.extension, skills: p.skills, mcp: p.mcp, only: ids }, env, platform, home);
  for (const l of r.lines) io.out(l);
  return 0;
}
