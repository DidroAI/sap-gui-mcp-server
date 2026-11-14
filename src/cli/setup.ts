/**
 * `setup`: adds this server to the MCP clients found on this machine.
 *
 * - Claude Code: `claude mcp add sap-gui --scope user -- <command>`;
 * - Codex: a `[mcp_servers.sap-gui]` table in ~/.codex/config.toml;
 * - Claude Desktop: an `mcpServers["sap-gui"]` entry in claude_desktop_config.json.
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

export function setup(opts: { dryRun: boolean; only?: string[] }, env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): SetupResult {
  const argv1 = (() => {
    try {
      return realpathSync(process.argv[1] ?? "");
    } catch {
      return process.argv[1] ?? "";
    }
  })();
  const command = launchCommand(argv1, platform, onPath(PACKAGE, platform), process.execPath);
  const want = (c: string) => !opts.only?.length || opts.only.includes(c);
  const lines: string[] = [`Command for MCP clients: ${command.join(" ")}`, ""];
  let changed = 0;
  let found = 0;

  if (want("claude-code")) {
    if (onPath("claude", platform)) {
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
    if (onPath("codex", platform) || existsSync(dirname(file))) {
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
      let config: { mcpServers?: Record<string, unknown> } = {};
      try {
        config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      } catch {
        lines.push(`✗ Claude Desktop: ${file} is not valid JSON; add "${NAME}" by hand.`);
        config = { mcpServers: { [NAME]: true } };
      }
      if (config.mcpServers?.[NAME] === true) {
        // invalid file, reported above
      } else if (config.mcpServers?.[NAME]) lines.push(`✓ Claude Desktop: "${NAME}" is already in ${file}.`);
      else if (opts.dryRun) lines.push(`• Claude Desktop: would add "${NAME}" to ${file}.`);
      else {
        backup(file);
        config.mcpServers = { ...(config.mcpServers ?? {}), [NAME]: { command: command[0], args: command.slice(1) } };
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        changed++;
        lines.push(`✓ Claude Desktop: added "${NAME}" to ${file}. Quit and reopen Claude Desktop to load it.`);
      }
    } else lines.push("– Claude Desktop: not found.");
  }

  if (!found) lines.push("", `No MCP client found. Add this command to your client's MCP settings by hand: ${command.join(" ")}`);
  lines.push("", "Next: sap-gui-mcp-server doctor");
  return { lines, changed };
}
