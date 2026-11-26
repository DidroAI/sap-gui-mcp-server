/**
 * The coding agents `setup` knows: how to find each one, where its MCP config lives and in
 * which format, and where it reads a user's skills. One table, in the order the prompt shows it.
 *
 * Detection follows `npx skills` (github.com/vercel-labs/skills, src/agents.ts): the agent's
 * config folder, or its command on PATH. An MCP format is listed only when the agent's own
 * docs give it (URL in `mcpDoc`); an agent whose MCP config could not be checked there gets
 * the skills only. Skill folders follow the agent's docs and `npx skills` (docs/agents.md).
 *
 * The shared folder `~/.agents/skills` holds the one real copy of the skills (setup links the
 * other folders to it), so the agents that read it (Codex, Cursor, Windsurf, Cline, Zed, Warp)
 * need nothing more.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Env = Record<string, string | undefined>;

/** What detection and paths depend on: tests pass a temporary home. */
export interface Ctx {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  /** The project folder, for project-scoped configs (Cursor, VS Code). */
  cwd: string;
  /** Whether a command is on PATH. */
  has: (cmd: string) => boolean;
}

/** The shape of one server entry in a JSON config. */
export type EntryShape =
  /** { command, args, env } */
  | "plain"
  /** { type: "stdio", command, args, env } */
  | "stdio"
  /** { type: "local", command, args, env, tools: ["*"] } (GitHub Copilot CLI) */
  | "copilot"
  /** { type: "local", command: [..], environment } (OpenCode) */
  | "opencode";

export type McpTarget =
  /** `claude mcp add --scope user` */
  | { kind: "claude" }
  /** a `[mcp_servers.<name>]` table in Codex's config.toml */
  | { kind: "toml"; file: string }
  /** an entry under `key` (a path of object keys) in a JSON file; `comments`: the agent reads JSON with comments */
  | { kind: "json"; file: string; key: string[]; shape: EntryShape; comments: boolean }
  /** an `extensions:` entry in Goose's config.yaml */
  | { kind: "yaml"; file: string };

export interface Agent {
  id: string;
  name: string;
  detect: (c: Ctx) => boolean;
  /** Where its MCP config is. Absent: its format is not verified, skills only. Returns undefined where there is none on this platform. */
  mcp?: (c: Ctx) => McpTarget | undefined;
  /** The doc the MCP format was checked against. */
  mcpDoc?: string;
  /** Its user skills folder; absent: it reads no skills from disk. */
  skills?: (c: Ctx) => string;
  /** How the user loads a new server (for the closing line): "restart" or a short instruction. */
  reload?: string;
}

const xdg = (c: Ctx) => c.env.XDG_CONFIG_HOME || join(c.home, ".config");
const appData = (c: Ctx) => c.env.APPDATA || join(c.home, "AppData", "Roaming");
const at = (c: Ctx, ...p: string[]) => existsSync(join(c.home, ...p));
export const claudeHome = (c: Ctx) => c.env.CLAUDE_CONFIG_DIR || join(c.home, ".claude");
const codexHome = (c: Ctx) => c.env.CODEX_HOME || join(c.home, ".codex");
const copilotHome = (c: Ctx) => c.env.COPILOT_HOME || join(c.home, ".copilot");
/** The shared folder: the one real copy of the skills goes here. */
export const sharedSkills = (c: Ctx) => join(c.home, ".agents", "skills");

const json = (file: string, key: string[] = ["mcpServers"], shape: EntryShape = "plain", comments = false): McpTarget => ({ kind: "json", file, key, shape, comments });

export function claudeDesktopConfig(c: Ctx): string | undefined {
  if (c.platform === "darwin") return join(c.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (c.platform === "win32") return c.env.APPDATA ? join(c.env.APPDATA, "Claude", "claude_desktop_config.json") : undefined;
  return undefined;
}

/** Cursor's MCP servers: the project's file when it has one, else the user's. */
export function cursorConfig(c: Ctx): string {
  const project = join(c.cwd, ".cursor", "mcp.json");
  return existsSync(project) ? project : join(c.home, ".cursor", "mcp.json");
}

/**
 * Windsurf (now Devin Desktop): ~/.config/devin/mcp_config.json ($XDG_CONFIG_HOME/devin; %APPDATA%\devin
 * on Windows). The old ~/.codeium/windsurf file is only read by its discovery now, so it is never
 * written; that folder still counts as Windsurf being installed.
 */
export function windsurfConfig(c: Ctx): string {
  return join(c.platform === "win32" ? appData(c) : xdg(c), "devin", "mcp_config.json");
}

const zedDir = (c: Ctx) => (c.platform === "win32" ? join(appData(c), "Zed") : join(xdg(c), "zed"));
const gooseDir = (c: Ctx) => (c.platform === "win32" ? join(appData(c), "Block", "goose", "config") : join(xdg(c), "goose"));
/** The .jsonc file when the user has one, else the .json. */
const jsonOrJsonc = (base: string) => (existsSync(`${base}.jsonc`) ? `${base}.jsonc` : `${base}.json`);

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    // Its MCP config is written by its own command only.
    detect: (c) => c.has("claude"),
    mcp: () => ({ kind: "claude" }),
    mcpDoc: "https://code.claude.com/docs/en/mcp",
    skills: (c) => join(claudeHome(c), "skills"),
  },
  {
    id: "codex",
    name: "Codex",
    detect: (c) => c.has("codex") || existsSync(codexHome(c)),
    mcp: (c) => ({ kind: "toml", file: join(codexHome(c), "config.toml") }),
    mcpDoc: "https://developers.openai.com/codex/mcp",
    skills: sharedSkills,
    reload: "start a new Codex session",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    detect: (c) => {
      const f = claudeDesktopConfig(c);
      return !!f && existsSync(dirname(f));
    },
    mcp: (c) => {
      const f = claudeDesktopConfig(c);
      return f ? json(f) : undefined;
    },
    mcpDoc: "https://modelcontextprotocol.io/quickstart/user",
    reload: "quit and reopen Claude Desktop",
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: (c) => existsSync(join(c.cwd, ".cursor", "mcp.json")) || at(c, ".cursor"),
    mcp: (c) => json(cursorConfig(c)),
    mcpDoc: "https://cursor.com/docs/context/mcp",
    // Cursor reads ~/.agents/skills (and ~/.claude/skills): https://cursor.com/docs/context/skills
    skills: sharedSkills,
    reload: "reload Cursor's MCP servers (Settings → MCP)",
  },
  {
    id: "windsurf",
    name: "Windsurf (Devin Desktop)",
    detect: (c) => existsSync(dirname(windsurfConfig(c))) || at(c, ".codeium", "windsurf"),
    mcp: (c) => json(windsurfConfig(c)),
    mcpDoc: "https://docs.devin.ai/desktop/cascade/mcp",
    // It reads ~/.config/devin/skills and ~/.agents/skills: https://docs.devin.ai/desktop/cascade/skills
    skills: sharedSkills,
    reload: "refresh its MCP servers (Cascade → MCP)",
  },
  {
    id: "vscode",
    name: "VS Code (GitHub Copilot)",
    // MCP servers are per workspace: only a project that already has the file, or when named.
    detect: (c) => existsSync(join(c.cwd, ".vscode", "mcp.json")),
    mcp: (c) => json(join(c.cwd, ".vscode", "mcp.json"), ["servers"], "stdio", true),
    mcpDoc: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
    // https://code.visualstudio.com/docs/copilot/customization/agent-skills: personal skills in ~/.copilot/skills
    skills: (c) => join(c.home, ".copilot", "skills"),
    reload: "start it from VS Code's MCP view",
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    detect: (c) => c.has("copilot") || existsSync(copilotHome(c)),
    // { "mcpServers": { name: { "type": "local", "command", "args", "env", "tools": ["*"] } } }; COPILOT_HOME moves the folder.
    mcp: (c) => json(join(copilotHome(c), "mcp-config.json"), ["mcpServers"], "copilot"),
    mcpDoc: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    skills: (c) => join(copilotHome(c), "skills"),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    detect: (c) => c.has("gemini") || at(c, ".gemini", "settings.json"),
    // ~/.gemini/settings.json, "mcpServers": { name: { command, args, env } }
    mcp: (c) => json(join(c.home, ".gemini", "settings.json")),
    mcpDoc: "https://geminicli.com/docs/tools/mcp-server/",
    skills: (c) => join(c.home, ".gemini", "skills"),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    detect: (c) => at(c, ".gemini", "antigravity"),
    // ~/.gemini/config/mcp_config.json, "mcpServers": { name: { command, args, env } }
    mcp: (c) => json(join(c.home, ".gemini", "config", "mcp_config.json")),
    mcpDoc: "https://antigravity.google/docs/mcp",
    skills: (c) => join(c.home, ".gemini", "config", "skills"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    detect: (c) => c.has("opencode") || existsSync(join(xdg(c), "opencode")),
    // ~/.config/opencode/opencode.json(c), "mcp": { "servers": { name: { "type": "local", "command": [..], "environment" } } }
    // (the schema at https://opencode.ai/config.json still takes the older "mcp": { name: {..} }; a file that uses it keeps it).
    mcp: (c) => json(jsonOrJsonc(join(xdg(c), "opencode", "opencode")), ["mcp", "servers"], "opencode", true),
    mcpDoc: "https://opencode.ai/docs/mcp-servers/",
    skills: (c) => join(xdg(c), "opencode", "skills"),
  },
  {
    id: "cline",
    name: "Cline",
    detect: (c) => c.has("cline") || at(c, ".cline"),
    // The file its docs name: ~/.cline/data/settings/cline_mcp_settings.json (CLINE_MCP_SETTINGS_PATH moves it).
    // The VS Code extension's own copy lives in VS Code's storage, which the docs do not name: not written.
    mcp: (c) => json(c.env.CLINE_MCP_SETTINGS_PATH || join(c.home, ".cline", "data", "settings", "cline_mcp_settings.json")),
    mcpDoc: "https://docs.cline.bot/mcp/configuring-mcp-servers",
    skills: sharedSkills,
  },
  {
    id: "roo",
    name: "Roo Code",
    // Its global mcp_settings.json lives in VS Code's storage, at a path its docs do not give: skills only.
    detect: (c) => at(c, ".roo"),
    skills: (c) => join(c.home, ".roo", "skills"),
  },
  {
    id: "kiro",
    name: "Kiro",
    detect: (c) => c.has("kiro-cli") || at(c, ".kiro"),
    // ~/.kiro/settings/mcp.json, read by the Kiro IDE and Kiro CLI alike.
    mcp: (c) => json(join(c.home, ".kiro", "settings", "mcp.json")),
    mcpDoc: "https://kiro.dev/docs/mcp/configuration/",
    skills: (c) => join(c.home, ".kiro", "skills"),
  },
  {
    id: "zed",
    name: "Zed",
    detect: (c) => existsSync(zedDir(c)),
    // settings.json (JSON with comments), "context_servers": { name: { command, args, env } }
    mcp: (c) => json(join(zedDir(c), "settings.json"), ["context_servers"], "plain", true),
    mcpDoc: "https://zed.dev/docs/ai/mcp",
    skills: sharedSkills,
  },
  {
    id: "goose",
    name: "Goose",
    detect: (c) => c.has("goose") || existsSync(gooseDir(c)),
    mcp: (c) => ({ kind: "yaml", file: join(gooseDir(c), "config.yaml") }),
    mcpDoc: "https://goose-docs.ai/docs/guides/config-files",
    skills: (c) => join(xdg(c), "goose", "skills"),
  },
  {
    id: "amp",
    name: "Amp",
    detect: (c) => c.has("amp") || at(c, ".config", "amp"),
    // ~/.config/amp/settings.json(c) on every OS (%USERPROFILE%\.config\amp), "amp.mcpServers": { name: { command, args, env } }
    mcp: (c) => json(jsonOrJsonc(join(c.home, ".config", "amp", "settings")), ["amp.mcpServers"], "plain", true),
    mcpDoc: "https://ampcode.com/docs/customize/mcp",
    skills: (c) => join(c.home, ".config", "agents", "skills"),
  },
  {
    id: "junie",
    name: "Junie",
    detect: (c) => c.has("junie") || at(c, ".junie"),
    // ~/.junie/mcp/mcp.json, the IDE plugin and Junie CLI alike
    mcp: (c) => json(join(c.home, ".junie", "mcp", "mcp.json")),
    mcpDoc: "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
    skills: (c) => join(c.home, ".junie", "skills"),
  },
  {
    id: "warp",
    name: "Warp",
    detect: (c) => at(c, ".warp"),
    // ~/.warp/.mcp.json; its docs give no Windows path, so not written there.
    mcp: (c) => (c.platform === "win32" ? undefined : json(join(c.home, ".warp", ".mcp.json"))),
    mcpDoc: "https://docs.warp.dev/agents/capabilities/mcp",
    skills: sharedSkills,
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    detect: (c) => c.has("qwen") || at(c, ".qwen"),
    mcp: (c) => json(join(c.home, ".qwen", "settings.json")),
    mcpDoc: "https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/",
    skills: (c) => join(c.home, ".qwen", "skills"),
  },
  {
    id: "droid",
    name: "Factory Droid",
    detect: (c) => c.has("droid") || at(c, ".factory"),
    mcp: (c) => json(join(c.home, ".factory", "mcp.json"), ["mcpServers"], "stdio"),
    mcpDoc: "https://docs.factory.com/cli/configuration/mcp",
    skills: (c) => join(c.home, ".factory", "skills"),
  },
  // Skills only: their MCP config was not verified from their docs (Crush moved to a crushrc file).
  { id: "crush", name: "Crush", detect: (c) => c.has("crush") || at(c, ".config", "crush"), skills: (c) => join(c.home, ".config", "crush", "skills") },
  { id: "augment", name: "Augment", detect: (c) => at(c, ".augment"), skills: (c) => join(c.home, ".augment", "skills") },
  { id: "continue", name: "Continue", detect: (c) => at(c, ".continue"), skills: (c) => join(c.home, ".continue", "skills") },
  { id: "kilo", name: "Kilo Code", detect: (c) => at(c, ".kilo") || at(c, ".kilocode"), skills: (c) => join(c.home, ".kilo", "skills") },
  { id: "trae", name: "Trae", detect: (c) => at(c, ".trae"), skills: (c) => join(c.home, ".trae", "skills") },
];

export const AGENT_IDS = AGENTS.map((a) => a.id);
export const agentById = (id: string) => AGENTS.find((a) => a.id === id);

/** The agents found on this machine (and in this project), by id, in table order. */
export function detectAgents(c: Ctx): string[] {
  return AGENTS.filter((a) => a.detect(c)).map((a) => a.id);
}

export type Selection = { ids: string[] } | { prompt: string[] } | { error: string };

/**
 * Which agents to set up. Names given (`setup codex cursor`, `--agent codex,cursor`, `-a codex -a cursor`)
 * win; `*` stands for every agent found. Without names: a prompt in a terminal, every agent found otherwise
 * (or with --yes).
 */
export function selectAgents(named: string[], detected: string[], interactive: boolean): Selection {
  const ids = named.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean);
  if (!ids.length) return interactive ? { prompt: detected } : { ids: detected };
  const unknown = ids.filter((id) => id !== "*" && !agentById(id));
  if (unknown.length) return { error: `Unknown agent ${unknown.map((u) => `"${u}"`).join(", ")}. Agents: ${AGENT_IDS.join(", ")}, or * for every one found.` };
  const picked = new Set(ids.flatMap((id) => (id === "*" ? detected : [id])));
  return { ids: AGENT_IDS.filter((id) => picked.has(id)) };
}
