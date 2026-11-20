/**
 * `setup`: adds this server to the MCP clients found on this machine.
 *
 * - Claude Code: `claude mcp add sap-gui --scope user -- <command>`;
 * - Codex: a `[mcp_servers.sap-gui]` table in ~/.codex/config.toml;
 * - Claude Desktop: an `mcpServers["sap-gui"]` entry in claude_desktop_config.json;
 * - Cursor: an `mcpServers["sap-gui"]` entry in the project's .cursor/mcp.json when
 *   that file exists, else in ~/.cursor/mcp.json;
 * - Windsurf (now Devin Desktop): an `mcpServers["sap-gui"]` entry in ~/.config/devin/mcp_config.json
 *   ($XDG_CONFIG_HOME/devin; %APPDATA%\\devin on Windows). The old ~/.codeium/windsurf file is only
 *   read by its discovery now, so it is never written; that folder still counts as Windsurf being installed;
 * - VS Code (Copilot): a `servers["sap-gui"]` entry in the project's .vscode/mcp.json,
 *   only when that file exists or `vscode` is named.
 *
 * It never overwrites an existing sap-gui entry, keeps a .bak copy of a
 * config file it changes, and with --dry-run only says what it would do.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const NAME = "sap-gui";
const PACKAGE = "sap-gui-mcp-server";

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
export function codexTable(command: string[]): string {
  const q = (s: string) => JSON.stringify(s);
  return `\n[mcp_servers.${NAME}]\ncommand = ${q(command[0] ?? "")}\nargs = [${command.slice(1).map(q).join(", ")}]\n`;
}

function claudeDesktopConfig(platform: NodeJS.Platform, env: Env, home: string): string | undefined {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return env.APPDATA ? join(env.APPDATA, "Claude", "claude_desktop_config.json") : undefined;
  return undefined;
}

function backup(file: string): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
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
  let config: Record<string, unknown> = {};
  try {
    config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8") || "{}") as Record<string, unknown>) : {};
  } catch {
    return { line: `✗ ${label}: ${file} is not valid JSON; add "${NAME}" by hand.`, changed: false };
  }
  const servers = (config[key] ?? {}) as Record<string, unknown>;
  if (servers[NAME]) return { line: `✓ ${label}: "${NAME}" is already in ${file}.`, changed: false };
  if (dryRun) return { line: `• ${label}: would add "${NAME}" to ${file}.`, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  backup(file);
  config[key] = { ...servers, [NAME]: entry };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { line: `✓ ${label}: added "${NAME}" to ${file}. ${after}`, changed: true };
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
  const lines: string[] = [`Command for MCP clients: ${command.join(" ")}`, ""];
  let changed = 0;
  let found = 0;

  if (want("claude-code")) {
    if (has("claude")) {
      found++;
      // From the home folder: a project's own .mcp.json must not count as installed.
      const has = spawnSync("claude", ["mcp", "get", NAME], { encoding: "utf8", shell: platform === "win32", cwd: home }).status === 0;
      if (has) lines.push(`✓ Claude Code: "${NAME}" is already configured (claude mcp get ${NAME}).`);
      else if (opts.dryRun) lines.push(`• Claude Code: would run claude mcp add ${NAME} --scope user -- ${command.join(" ")}`);
      else {
        const r = spawnSync("claude", ["mcp", "add", NAME, "--scope", "user", "--", ...command], { encoding: "utf8", shell: platform === "win32", cwd: home });
        if (r.status === 0) {
          changed++;
          lines.push(`✓ Claude Code: added "${NAME}" for your user. Restart Claude Code to load it.`);
        } else lines.push(`✗ Claude Code: claude mcp add failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
      }
    } else lines.push("– Claude Code: not found (no claude command).");
  }

  if (want("codex")) {
    const file = join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
    if (has("codex") || existsSync(dirname(file))) {
      found++;
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (new RegExp(`^\\[mcp_servers\\.${NAME}\\]`, "m").test(text)) lines.push(`✓ Codex: "${NAME}" is already in ${file}.`);
      else if (opts.dryRun) lines.push(`• Codex: would add to ${file}:${codexTable(command)}`);
      else {
        mkdirSync(dirname(file), { recursive: true });
        backup(file);
        writeFileSync(file, text + codexTable(command));
        changed++;
        lines.push(`✓ Codex: added "${NAME}" to ${file}. Start a new Codex session to load it.`);
      }
    } else lines.push("– Codex: not found (no codex command, no ~/.codex).");
  }

  if (want("claude-desktop")) {
    const file = claudeDesktopConfig(platform, env, home);
    if (file && existsSync(dirname(file))) {
      found++;
      const r = addJsonServer(file, "mcpServers", { command: command[0], args: command.slice(1) }, "Claude Desktop", "Quit and reopen Claude Desktop to load it.", opts.dryRun);
      if (r.changed) changed++;
      lines.push(r.line);
    } else lines.push("– Claude Desktop: not found.");
  }

  if (want("cursor")) {
    const file = cursorConfig(cwd, home) ?? (opts.only?.includes("cursor") ? join(home, ".cursor", "mcp.json") : undefined);
    if (file) {
      found++;
      const r = addJsonServer(file, "mcpServers", { command: command[0], args: command.slice(1) }, "Cursor", "Reload Cursor's MCP servers (Settings → MCP) to load it.", opts.dryRun);
      if (r.changed) changed++;
      lines.push(r.line);
    } else lines.push("– Cursor: not found (no ~/.cursor, no .cursor/mcp.json here).");
  }

  if (want("windsurf")) {
    const file = windsurfConfig(platform, env, home);
    if (windsurfFound(platform, env, home) || opts.only?.includes("windsurf")) {
      found++;
      const r = addJsonServer(file, "mcpServers", { command: command[0], args: command.slice(1) }, "Windsurf (Devin Desktop)", "Refresh its MCP servers (Cascade → MCP) to load it.", opts.dryRun);
      if (r.changed) changed++;
      lines.push(r.line);
    } else lines.push("– Windsurf (Devin Desktop): not found.");
  }

  // VS Code keeps MCP servers per workspace: only touch a project that already has the file, or when asked.
  if (want("vscode") && (opts.only?.includes("vscode") || existsSync(join(cwd, ".vscode", "mcp.json")))) {
    found++;
    const file = join(cwd, ".vscode", "mcp.json");
    const r = addJsonServer(file, "servers", { type: "stdio", command: command[0], args: command.slice(1) }, "VS Code", "Start it from the MCP view (or reload the window).", opts.dryRun);
    if (r.changed) changed++;
    lines.push(r.line);
  }

  if (!found) lines.push("", `No MCP client found. Add this command to your client's MCP settings by hand: ${command.join(" ")}`);
  lines.push(
    "",
    changed ? "Next: restart the clients marked above, open an SAP screen, and ask your agent to look at it." : "Next: open an SAP screen and ask your agent to look at it.",
    "If it cannot see SAP, run sap-gui-mcp-server doctor.",
  );
  return { lines, changed };
}
