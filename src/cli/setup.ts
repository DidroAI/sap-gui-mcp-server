/**
 * `setup`: adds this server to the MCP clients found on this machine.
 *
 * - Claude Code: `claude mcp add sap-ui-automation --scope user -- <command>`;
 * - Codex: a `[mcp_servers.sap-ui-automation]` table in ~/.codex/config.toml;
 * - Claude Desktop: an `mcpServers["sap-ui-automation"]` entry in claude_desktop_config.json;
 * - Cursor: an `mcpServers["sap-ui-automation"]` entry in the project's .cursor/mcp.json when
 *   that file exists, else in ~/.cursor/mcp.json;
 * - Windsurf (now Devin Desktop): an `mcpServers["sap-ui-automation"]` entry in ~/.config/devin/mcp_config.json
 *   ($XDG_CONFIG_HOME/devin; %APPDATA%\\devin on Windows). The old ~/.codeium/windsurf file is only
 *   read by its discovery now, so it is never written; that folder still counts as Windsurf being installed;
 * - VS Code (Copilot): a `servers["sap-ui-automation"]` entry in the project's .vscode/mcp.json,
 *   only when that file exists or `vscode` is named.
 *
 * It never overwrites an existing sap-ui-automation entry, keeps a .bak copy of a
 * config file it changes (the first one: a later run does not replace it), and
 * with --dry-run only says what it would do. A config it cannot read safely is
 * left alone, with the entry to add by hand.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type InstallResult, installNativeHost, STORE_URL } from "../browser/extension/native.js";
import { setupSkills, userSkillDirs } from "./skills.js";

export const NAME = "sap-ui-automation";
const PACKAGE = "sap-ui-automation";
/** Names this server had before the rename (2026-11-24): an entry left under one gives the agent the tools twice. */
export const OLD_NAMES = ["sap-gui-mcp-server", "sap-gui"] as const;

/** The old names a JSON config holds under `key`. */
export function oldJsonEntries(text: string, key: string): string[] {
  try {
    const servers = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return isPlainObject(servers) ? OLD_NAMES.filter((n) => n in servers) : [];
  } catch {
    return [];
  }
}

/** The old names a Codex config.toml has a table for. */
export function oldCodexEntries(text: string): string[] {
  return OLD_NAMES.filter((n) => new RegExp(`^\\s*\\[mcp_servers\\.(?:${n}|"${n}"|'${n}')\\]`, "m").test(text));
}

const oldLine = (name: string, how: string) => `  ! Also found "${name}", this server's name before 0.1.0: the agent gets its tools twice. Remove it: ${how}`;

type Env = Record<string, string | undefined>;

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

function claudeDesktopConfig(platform: NodeJS.Platform, env: Env, home: string): string | undefined {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return env.APPDATA ? join(env.APPDATA, "Claude", "claude_desktop_config.json") : undefined;
  return undefined;
}

/** Keeps a copy of the file as it was before setup first changed it. */
function backup(file: string): void {
  if (existsSync(file) && !existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`);
}

/** Writes through a temporary file and a rename, so a crash never leaves half a config. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

export interface SetupResult {
  lines: string[];
  changed: number;
}

export interface SetupOptions {
  dryRun: boolean;
  /** Only these clients: claude-code, codex, claude-desktop, cursor, windsurf, vscode. */
  only?: string[];
  /** The project folder for project-scoped configs (Cursor, VS Code). Default: process.cwd(). */
  cwd?: string | undefined;
  /** Whether a command is on PATH (tests replace it). */
  onPath?: ((cmd: string) => boolean) | undefined;
  /** Through the Chrome extension: the new entries get SAP_BROWSER=extension. */
  extension?: boolean | undefined;
  /** Install the bundled skills for the apps set up (Claude Code, Codex, Cursor). Default: true. */
  skills?: boolean | undefined;
  /** Where the skills come from (tests). Default: this package. */
  skillsRoot?: string | undefined;
  /** With extension: installs the extension's helper (tests replace it). */
  installHelper?: (() => InstallResult) | undefined;
}

export const CLIENTS = ["claude-code", "codex", "claude-desktop", "cursor", "windsurf", "vscode"] as const;
export type Client = (typeof CLIENTS)[number];

/** Where Cursor's MCP servers go: the project's file when it has one, else the user's. */
function cursorConfig(cwd: string, home: string): string | undefined {
  const project = join(cwd, ".cursor", "mcp.json");
  if (existsSync(project)) return project;
  if (existsSync(join(home, ".cursor"))) return join(home, ".cursor", "mcp.json");
  return undefined;
}

/** Windsurf's (Devin Desktop's) MCP config file. */
function windsurfConfig(platform: NodeJS.Platform, env: Env, home: string): string {
  const base = platform === "win32" ? (env.APPDATA ?? join(home, "AppData", "Roaming")) : (env.XDG_CONFIG_HOME || join(home, ".config"));
  return join(base, "devin", "mcp_config.json");
}
/** Is Windsurf / Devin Desktop installed: its config folder, or the folder of the older Windsurf. */
const windsurfFound = (platform: NodeJS.Platform, env: Env, home: string) => existsSync(dirname(windsurfConfig(platform, env, home))) || existsSync(join(home, ".codeium", "windsurf"));

/** The clients this machine (and project) has, without changing anything. */
export function detectClients(opts: { cwd?: string | undefined; onPath?: ((cmd: string) => boolean) | undefined } = {}, env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): Client[] {
  const has = opts.onPath ?? ((c: string) => onPath(c, platform));
  const cwd = opts.cwd ?? process.cwd();
  const found: Client[] = [];
  if (has("claude")) found.push("claude-code");
  if (has("codex") || existsSync(env.CODEX_HOME ?? join(home, ".codex"))) found.push("codex");
  const desktop = claudeDesktopConfig(platform, env, home);
  if (desktop && existsSync(dirname(desktop))) found.push("claude-desktop");
  if (cursorConfig(cwd, home)) found.push("cursor");
  if (windsurfFound(platform, env, home)) found.push("windsurf");
  if (existsSync(join(cwd, ".vscode", "mcp.json"))) found.push("vscode");
  return found;
}

/**
 * Adds `entry` under `key` ("mcpServers" or "servers") of a JSON config file,
 * unless it is there already. Returns the line to print and whether it changed the file.
 */
function addJsonServer(file: string, key: string, entry: Record<string, unknown>, label: string, after: string, dryRun: boolean): { line: string; changed: boolean } {
  let config: unknown = {};
  try {
    config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "{}") : {};
  } catch {
    return { line: `✗ ${label}: ${file} is not valid JSON; add "${NAME}" by hand.`, changed: false };
  }
  const byHand = `add this under "${key}" by hand: "${NAME}": ${JSON.stringify(entry)}`;
  if (!isPlainObject(config)) return { line: `✗ ${label}: ${file} does not hold a JSON object; ${byHand}`, changed: false };
  const servers = config[key] ?? {};
  if (!isPlainObject(servers)) return { line: `✗ ${label}: "${key}" in ${file} is not an object; ${byHand}`, changed: false };
  if (servers[NAME]) {
    const env = (entry.env ?? {}) as Record<string, string>;
    const old = isPlainObject(servers[NAME]) && isPlainObject((servers[NAME] as Record<string, unknown>).env) ? ((servers[NAME] as Record<string, unknown>).env as Record<string, unknown>) : {};
    const missing = Object.entries(env).filter(([k, v]) => old[k] !== v);
    return { line: `✓ ${label}: "${NAME}" is already in ${file}.${missing.length ? ` Add ${missing.map(([k, v]) => `"${k}": "${v}"`).join(", ")} to its "env".` : ""}`, changed: false };
  }
  if (dryRun) return { line: `• ${label}: would add "${NAME}" to ${file}.`, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  backup(file);
  config[key] = { ...servers, [NAME]: entry };
  writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return { line: `✓ ${label}: added "${NAME}" to ${file}. ${after}`, changed: true };
}

/** A line per old entry in a JSON config: removed by hand, never by setup. */
function oldInJson(file: string, key: string): string[] {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return oldJsonEntries(text, key).map((old) => oldLine(old, `delete "${old}" under "${key}" in ${file}`));
}

export function setup(opts: SetupOptions, env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): SetupResult {
  const argv1 = (() => {
    try {
      return realpathSync(process.argv[1] ?? "");
    } catch {
      return process.argv[1] ?? "";
    }
  })();
  const has = opts.onPath ?? ((c: string) => onPath(c, platform));
  const cwd = opts.cwd ?? process.cwd();
  const command = launchCommand(argv1, platform, has(PACKAGE), process.execPath);
  const want = (c: string) => !opts.only?.length || opts.only.includes(c);
  // --extension: the server reaches Chrome through the extension. Only new entries get it; an existing one is named.
  const vars: Record<string, string> = opts.extension ? { SAP_BROWSER: "extension" } : {};
  const withEnv = (entry: Record<string, unknown>) => (opts.extension ? { ...entry, env: vars } : entry);
  const envNote = opts.extension ? ` If it does not have SAP_BROWSER=extension yet, add it to its env.` : "";
  const lines: string[] = [`Command for MCP clients: ${command.join(" ")}`, ""];
  let changed = 0;
  let found = 0;
  /** The apps that have the server now: they get the skills. */
  const ready: Client[] = [];
  let skillsChanged = false;

  if (want("claude-code")) {
    if (has("claude")) {
      found++;
      // From the home folder: a project's own .mcp.json must not count as installed.
      const has = runClaude(["mcp", "get", NAME], platform, home).status === 0;
      const envArgs = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      if (has || opts.dryRun) ready.push("claude-code");
      if (has) lines.push(`✓ Claude Code: "${NAME}" is already configured (claude mcp get ${NAME}).${envNote}`);
      else if (opts.dryRun) lines.push(`• Claude Code: would run claude mcp add ${NAME} --scope user ${envArgs.length ? `${envArgs.join(" ")} ` : ""}-- ${command.join(" ")}`);
      else {
        const r = runClaude(["mcp", "add", NAME, "--scope", "user", ...envArgs, "--", ...command], platform, home);
        if (r.status === 0) {
          changed++;
          ready.push("claude-code");
          lines.push(`✓ Claude Code: added "${NAME}" for your user. Restart Claude Code to load it.`);
        } else lines.push(`✗ Claude Code: claude mcp add failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
      }
      for (const old of OLD_NAMES) if (runClaude(["mcp", "get", old], platform, home).status === 0) lines.push(oldLine(old, `claude mcp remove ${old}`));
    } else lines.push("– Claude Code: not found (no claude command).");
  }

  if (want("codex")) {
    const file = join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
    if (has("codex") || existsSync(dirname(file))) {
      found++;
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const present = codexHas(text);
      if (present !== "unsure") ready.push("codex");
      if (present === "yes") lines.push(`✓ Codex: "${NAME}" is already in ${file}.${envNote}`);
      else if (present === "unsure") {
        lines.push(`✗ Codex: ${file} names "${NAME}" in a form setup does not read; check it, or add this table by hand:`);
        lines.push(...codexTable(command, vars).trim().split("\n").map((l) => `    ${l}`));
      } else if (opts.dryRun) lines.push(`• Codex: would add to ${file}:${codexTable(command, vars)}`);
      else {
        mkdirSync(dirname(file), { recursive: true });
        backup(file);
        writeAtomic(file, text + codexTable(command, vars));
        changed++;
        lines.push(`✓ Codex: added "${NAME}" to ${file}. Start a new Codex session to load it.`);
      }
      for (const old of oldCodexEntries(text)) lines.push(oldLine(old, `codex mcp remove ${old}`));
    } else lines.push("– Codex: not found (no codex command, no ~/.codex).");
  }

  if (want("claude-desktop")) {
    const file = claudeDesktopConfig(platform, env, home);
    if (file && existsSync(dirname(file))) {
      found++;
      const r = addJsonServer(file, "mcpServers", withEnv({ command: command[0], args: command.slice(1) }), "Claude Desktop", "Quit and reopen Claude Desktop to load it.", opts.dryRun);
      if (r.changed) changed++;
      lines.push(r.line, ...oldInJson(file, "mcpServers"));
    } else lines.push("– Claude Desktop: not found.");
  }

  if (want("cursor")) {
    const file = cursorConfig(cwd, home) ?? (opts.only?.includes("cursor") ? join(home, ".cursor", "mcp.json") : undefined);
    if (file) {
      found++;
      const r = addJsonServer(file, "mcpServers", withEnv({ command: command[0], args: command.slice(1) }), "Cursor", "Reload Cursor's MCP servers (Settings → MCP) to load it.", opts.dryRun);
      if (r.changed) changed++;
      if (!r.line.startsWith("✗")) ready.push("cursor");
      lines.push(r.line, ...oldInJson(file, "mcpServers"));
    } else lines.push("– Cursor: not found (no ~/.cursor, no .cursor/mcp.json here).");
  }

  if (want("windsurf")) {
    const file = windsurfConfig(platform, env, home);
    if (windsurfFound(platform, env, home) || opts.only?.includes("windsurf")) {
      found++;
      const r = addJsonServer(file, "mcpServers", withEnv({ command: command[0], args: command.slice(1) }), "Windsurf (Devin Desktop)", "Refresh its MCP servers (Cascade → MCP) to load it.", opts.dryRun);
      if (r.changed) changed++;
      lines.push(r.line, ...oldInJson(file, "mcpServers"));
    } else lines.push("– Windsurf (Devin Desktop): not found.");
  }

  // VS Code keeps MCP servers per workspace: only touch a project that already has the file, or when asked.
  if (want("vscode") && (opts.only?.includes("vscode") || existsSync(join(cwd, ".vscode", "mcp.json")))) {
    found++;
    const file = join(cwd, ".vscode", "mcp.json");
    const r = addJsonServer(file, "servers", withEnv({ type: "stdio", command: command[0], args: command.slice(1) }), "VS Code", "Start it from the MCP view (or reload the window).", opts.dryRun);
    if (r.changed) changed++;
    lines.push(r.line, ...oldInJson(file, "servers"));
  }

  // The skills, where each app that has the server reads them: the agent uses one when a task matches it.
  if (opts.skills !== false && ready.length) {
    const show = (p: string) => (p.startsWith(home + sep) ? join("~", relative(home, p)) : p);
    const label: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
    for (const { dir, clients } of userSkillDirs(ready, home, env)) {
      const { installed, left, removed } = setupSkills(dir, opts.dryRun, opts.skillsRoot);
      const who = clients.map((c) => label[c]).join(", ");
      // Skills load when the app starts a new session: a restart, as for the server.
      if (installed.length && !opts.dryRun) skillsChanged = true;
      if (installed.length) lines.push(`${opts.dryRun ? "•" : "✓"} Skills for ${who}: ${opts.dryRun ? "would install" : "installed"} ${installed.join(", ")} in ${show(dir)}.`);
      if (removed.length) lines.push(`${opts.dryRun ? "•" : "✓"} Skills for ${who}: ${opts.dryRun ? "would remove" : "removed"} ${removed.join(", ")} in ${show(dir)} (the old names).`);
      if (left.length) lines.push(`– Skills for ${who}: ${left.join(", ")} in ${show(dir)} ${left.length > 1 ? "are" : "is"} not from this package, left as ${left.length > 1 ? "they are" : "it is"}.`);
    }
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

  if (!found) lines.push("", `No MCP client found. Add this command to your client's MCP settings by hand: ${command.join(" ")}`);
  lines.push(
    "",
    changed || skillsChanged ? "Next: restart the clients marked above, and ask your agent to look at your SAP screen." : "Next: ask your agent to look at your SAP screen.",
    ...(opts.extension
      ? [
          `In Chrome: add UI Automation for SAP if you have not (${STORE_URL}),${helperOk ? " restart Chrome once," : ""} then click its icon and Pair in the side panel, and add your SAP systems there.`,
        ]
      : ["For Web GUI and Fiori, a Chrome window opens: open your SAP address there and log on, once."]),
    "If it cannot see SAP, run npx -y sap-ui-automation doctor.",
  );
  return { lines, changed };
}
