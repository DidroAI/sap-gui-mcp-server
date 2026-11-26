import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, AGENTS, type Ctx, detectAgents, selectAgents } from "../src/cli/agents.js";
import { addToGoose, addToJson, jsonEntry } from "../src/cli/mcp-config.js";
import { pickKey, renderPick } from "../src/cli/prompt.js";
import { parseSetupArgs, setup, setupCommand } from "../src/cli/setup.js";
import { packageRoot, setupSharedSkills } from "../src/cli/skills.js";

// Every test gets its own HOME and project folder and sees no command on PATH:
// nothing here may touch the real home folder or run a real `claude`.
let root: string;
let home: string;
let cwd: string;
const none = () => false;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ home, cwd, env: {}, platform: "linux", has: none, ...over });
const read = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p));
const mk = (...p: string[]) => mkdirSync(join(home, ...p), { recursive: true });
const sk = (...p: string[]) => join("~", ...p);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sap-agents-"));
  home = join(root, "home");
  cwd = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the agent table", () => {
  test("ids are unique, and every agent has a skills folder or an MCP config", () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length);
    for (const a of AGENTS) expect(!!a.skills || !!a.mcp).toBe(true);
    // an MCP format is only listed with the doc it was checked against
    for (const a of AGENTS) if (a.mcp) expect(a.mcpDoc).toStartWith("https://");
  });

  // What makes each agent count as installed, in a home of its own.
  const markers: Record<string, () => Partial<Ctx> | void> = {
    "claude-code": () => ({ has: (c) => c === "claude" }),
    codex: () => void mk(".codex"),
    "claude-desktop": () => (mk("Library", "Application Support", "Claude"), { platform: "darwin" }),
    cursor: () => void mk(".cursor"),
    windsurf: () => void mk(".codeium", "windsurf"),
    vscode: () => (mkdirSync(join(cwd, ".vscode")), writeFileSync(join(cwd, ".vscode", "mcp.json"), "{}")),
    "copilot-cli": () => void mk(".copilot"),
    "gemini-cli": () => (mk(".gemini"), writeFileSync(join(home, ".gemini", "settings.json"), "{}")),
    antigravity: () => void mk(".gemini", "antigravity"),
    opencode: () => void mk(".config", "opencode"),
    cline: () => void mk(".cline"),
    roo: () => void mk(".roo"),
    kiro: () => void mk(".kiro"),
    zed: () => void mk(".config", "zed"),
    goose: () => void mk(".config", "goose"),
    amp: () => void mk(".config", "amp"),
    junie: () => void mk(".junie"),
    warp: () => void mk(".warp"),
    "qwen-code": () => void mk(".qwen"),
    droid: () => void mk(".factory"),
    crush: () => void mk(".config", "crush"),
    augment: () => void mk(".augment"),
    continue: () => void mk(".continue"),
    kilo: () => void mk(".kilocode"),
    trae: () => void mk(".trae"),
  };

  test("every agent has a detection test", () => {
    expect(Object.keys(markers).sort()).toEqual([...AGENT_IDS].sort());
  });

  for (const id of AGENT_IDS)
    test(`detects ${id} by its folder or command, and nothing else`, () => {
      expect(detectAgents(ctx())).toEqual([]);
      const over = markers[id]?.() ?? {};
      expect(detectAgents(ctx(over))).toEqual([id]);
    });

  test("Windows paths: %APPDATA% for Zed, Goose, Claude Desktop and Windsurf; no Warp MCP path", () => {
    const appData = join(home, "AppData", "Roaming");
    const c = ctx({ platform: "win32", env: { APPDATA: appData } });
    const file = (id: string) => {
      const t = AGENTS.find((a) => a.id === id)?.mcp?.(c);
      return t && "file" in t ? t.file : t?.kind;
    };
    expect(file("zed")).toBe(join(appData, "Zed", "settings.json"));
    expect(file("goose")).toBe(join(appData, "Block", "goose", "config", "config.yaml"));
    expect(file("claude-desktop")).toBe(join(appData, "Claude", "claude_desktop_config.json"));
    expect(file("windsurf")).toBe(join(appData, "devin", "mcp_config.json"));
    expect(file("amp")).toBe(join(home, ".config", "amp", "settings.json"));
    expect(file("warp")).toBeUndefined();
    mkdirSync(join(appData, "Zed"), { recursive: true });
    expect(detectAgents(c)).toEqual(["zed"]);
  });

  test("CODEX_HOME, COPILOT_HOME, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME move the folders", () => {
    const c = ctx({ env: { CODEX_HOME: join(root, "cx"), COPILOT_HOME: join(root, "cp"), CLAUDE_CONFIG_DIR: join(root, "cc"), XDG_CONFIG_HOME: join(root, "xdg") } });
    const get = (id: string) => AGENTS.find((a) => a.id === id);
    expect(get("codex")?.mcp?.(c)).toEqual({ kind: "toml", file: join(root, "cx", "config.toml") });
    expect((get("copilot-cli")?.mcp?.(c) as { file: string }).file).toBe(join(root, "cp", "mcp-config.json"));
    expect(get("claude-code")?.skills?.(c)).toBe(join(root, "cc", "skills"));
    expect((get("opencode")?.mcp?.(c) as { file: string }).file).toBe(join(root, "xdg", "opencode", "opencode.json"));
  });
});

describe("choosing the agents", () => {
  test("names win; * is every agent found; without names: a prompt in a terminal, every agent found otherwise", () => {
    expect(selectAgents([], ["codex", "cursor"], false)).toEqual({ ids: ["codex", "cursor"] });
    expect(selectAgents([], ["codex"], true)).toEqual({ prompt: ["codex"] });
    expect(selectAgents(["cursor,codex"], [], true)).toEqual({ ids: ["codex", "cursor"] });
    expect(selectAgents(["*"], ["zed", "codex"], true)).toEqual({ ids: ["codex", "zed"] });
    expect(selectAgents(["*", "goose"], ["codex"], false)).toEqual({ ids: ["codex", "goose"] });
    expect("error" in selectAgents(["nope"], [], false)).toBe(true);
  });

  test("the flags: positional names, --agent lists and repeats, -a, --agent=, -y; unknown options refused", () => {
    expect(parseSetupArgs(["codex", "cursor", "--dry-run"])).toMatchObject({ named: ["codex", "cursor"], dryRun: true });
    expect(parseSetupArgs(["--agent", "codex,zed", "-a", "goose", "--agent=amp", "-y"])).toMatchObject({ named: ["codex,zed", "goose", "amp"], yes: true });
    expect(parseSetupArgs(["-a", "*", "--no-mcp", "--extension"])).toMatchObject({ named: ["*"], mcp: false, extension: true, skills: true });
    expect(parseSetupArgs(["--agent"])).toHaveProperty("error");
    expect(parseSetupArgs(["--bogus"])).toHaveProperty("error");
    expect(parseSetupArgs(["--no-mcp", "--no-skills"])).toHaveProperty("error");
  });

  const run = async (args: string[], tty: boolean, pick?: (c: { value: string }[], initial: string[]) => Promise<string[] | undefined>) => {
    const out: string[] = [];
    const code = await setupCommand(args, { out: (l) => out.push(l), tty, pick, home, env: {}, platform: "linux", options: { cwd, onPath: none } });
    return { code, out };
  };

  test("not a terminal: every agent found, no prompt", async () => {
    mk(".codex");
    mk(".kiro");
    const { code, out } = await run([], false, async () => {
      throw new Error("must not ask");
    });
    expect(code).toBe(0);
    expect(out[0]).toBe("Agents found: Codex, Kiro.");
    expect(out).toContain("Setting up: Codex, Kiro.");
    expect(existsSync(join(home, ".kiro", "settings", "mcp.json"))).toBe(true);
  });

  test("a terminal: the picker lists every agent with the found ones ticked; its answer is set up", async () => {
    mk(".codex");
    let seen: { choices: { value: string }[]; initial: string[] } | undefined;
    const { out } = await run([], true, async (choices, initial) => ((seen = { choices, initial }), ["kiro"]));
    expect(seen?.choices.map((c) => c.value)).toEqual(AGENT_IDS);
    expect(seen?.initial).toEqual(["codex"]);
    expect(out).toContain("Setting up: Kiro.");
    expect(existsSync(join(home, ".kiro", "settings", "mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("--yes and --agent skip the picker; cancelling or ticking nothing changes nothing", async () => {
    mk(".codex");
    const ask = async () => {
      throw new Error("must not ask");
    };
    expect((await run(["--yes", "--dry-run"], true, ask)).out).toContain("Setting up: Codex.");
    expect((await run(["--agent", "zed", "--dry-run"], true, ask)).out).toContain("Setting up: Zed.");
    const cancelled = await run([], true, async () => undefined);
    expect(cancelled.code).toBe(1);
    expect(cancelled.out).toContain("Cancelled; nothing changed.");
    expect((await run([], true, async () => [])).out).toContain("No agent selected; nothing changed.");
    expect(readdirSync(home)).toEqual([".codex"]);
    const bad = await run(["--agent", "nope"], false);
    expect(bad.code).toBe(2);
    expect(bad.out.at(-1)).toContain('Unknown agent "nope"');
  });

  test("the picker's keys", () => {
    const s = { cursor: 0, checked: [true, false, false] };
    expect(pickKey(s, { name: "down" })).toEqual({ cursor: 1, checked: [true, false, false] });
    expect(pickKey(s, { name: "up" })).toEqual({ cursor: 2, checked: [true, false, false] });
    expect(pickKey(s, { name: "space" })).toEqual({ cursor: 0, checked: [false, false, false] });
    expect(pickKey(s, { name: "a" })).toEqual({ cursor: 0, checked: [true, true, true] });
    expect(pickKey({ cursor: 0, checked: [true, true] }, { name: "a" })).toEqual({ cursor: 0, checked: [false, false] });
    expect(pickKey(s, { name: "return" })).toBe("done");
    expect(pickKey(s, { name: "c", ctrl: true })).toBe("cancel");
    expect(pickKey(s, { name: "escape" })).toBe("cancel");
    expect(renderPick("Pick", [{ value: "a", label: "A", hint: "found" }, { value: "b", label: "B" }], { cursor: 1, checked: [true, false] })).toEqual(["Pick  (↑/↓ move, space select, a all, Enter confirm)", "  ◉ A  found", "❯ ◯ B"]);
  });
});

describe("the MCP writers", () => {
  // Each JSON agent: its file on Linux (macOS for Claude Desktop), the key path and the entry it gets.
  const cases: { id: string; file: () => string; key: string[]; platform?: NodeJS.Platform; entry: Record<string, unknown> }[] = [
    { id: "claude-desktop", platform: "darwin", file: () => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "cursor", file: () => join(home, ".cursor", "mcp.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "windsurf", file: () => join(home, ".config", "devin", "mcp_config.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "vscode", file: () => join(cwd, ".vscode", "mcp.json"), key: ["servers"], entry: { type: "stdio", command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "copilot-cli", file: () => join(home, ".copilot", "mcp-config.json"), key: ["mcpServers"], entry: { type: "local", command: "npx", args: ["-y", "sap-ui-automation"], tools: ["*"] } },
    { id: "gemini-cli", file: () => join(home, ".gemini", "settings.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "antigravity", file: () => join(home, ".gemini", "config", "mcp_config.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "opencode", file: () => join(home, ".config", "opencode", "opencode.json"), key: ["mcp", "servers"], entry: { type: "local", command: ["npx", "-y", "sap-ui-automation"] } },
    { id: "cline", file: () => join(home, ".cline", "data", "settings", "cline_mcp_settings.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "kiro", file: () => join(home, ".kiro", "settings", "mcp.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "zed", file: () => join(home, ".config", "zed", "settings.json"), key: ["context_servers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "amp", file: () => join(home, ".config", "amp", "settings.json"), key: ["amp.mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "junie", file: () => join(home, ".junie", "mcp", "mcp.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "warp", file: () => join(home, ".warp", ".mcp.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "qwen-code", file: () => join(home, ".qwen", "settings.json"), key: ["mcpServers"], entry: { command: "npx", args: ["-y", "sap-ui-automation"] } },
    { id: "droid", file: () => join(home, ".factory", "mcp.json"), key: ["mcpServers"], entry: { type: "stdio", command: "npx", args: ["-y", "sap-ui-automation"] } },
  ];
  // As if run by npx: the entry's command is then npx -y sap-ui-automation.
  const viaNpx = <T>(f: () => T): T => {
    const was = process.argv[1];
    process.argv[1] = "/x/_npx/1/node_modules/sap-ui-automation/dist/cli.js";
    try {
      return f();
    } finally {
      process.argv[1] = was as string;
    }
  };
  const dig = (o: Record<string, unknown>, key: string[]) => key.reduce<Record<string, unknown>>((v, k) => v[k] as Record<string, unknown>, o);

  for (const c of cases)
    test(`${c.id}: a new file; a file with other servers keeps them; an entry already there is left`, () => {
      const platform = c.platform ?? "linux";
      const file = c.file();
      const go = () => viaNpx(() => setup({ dryRun: false, only: [c.id], cwd, onPath: none, skills: false }, {}, platform, home));
      const r = go();
      expect(r.changed).toBe(1);
      expect(dig(json(file), c.key)["sap-ui-automation"]).toEqual(c.entry);
      // other servers and settings stay
      const other: Record<string, unknown> = { theme: "dark" };
      let at = other;
      for (const k of c.key.slice(0, -1)) at = at[k] = {} as Record<string, unknown>;
      at[c.key.at(-1) as string] = { other: { command: "x" } };
      writeFileSync(file, JSON.stringify(other, null, 2));
      go();
      const after = json(file);
      expect(after.theme).toBe("dark");
      expect(dig(after, c.key).other).toEqual({ command: "x" });
      expect(dig(after, c.key)["sap-ui-automation"]).toEqual(c.entry);
      // there already: not written again
      const text = read(file);
      const again = go();
      expect(again.changed).toBe(0);
      expect(again.lines.some((l) => l.includes("server already in"))).toBe(true);
      expect(read(file)).toBe(text);
    });

  test("JSON with comments: kept where the agent reads them (Zed); refused where it does not (Cursor)", () => {
    const zed = '{\n  // my font\n  "buffer_font_size": 15,\n  "context_servers": {\n    "other": { "command": "x" },\n  },\n}\n';
    const r = addToJson(zed, ["context_servers"], { command: "npx", args: [] }, true);
    expect(r.kind).toBe("add");
    const out = (r as { text: string }).text;
    expect(out).toContain("// my font");
    expect(out).toContain('"other": { "command": "x" }');
    expect(out).toContain('"sap-ui-automation": {');
    expect(addToJson('{ /* c */ "mcpServers": {} }', ["mcpServers"], {}, false)).toEqual({ kind: "error", reason: "is not valid JSON" });
  });

  test("OpenCode: a file in the older form (servers right under mcp) keeps that form; environment carries the env", () => {
    const legacy = JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } });
    const r = addToJson(legacy, ["mcp", "servers"], jsonEntry("opencode", ["npx", "-y", "sap-ui-automation"], { SAP_BROWSER: "extension" }), true, { envKey: "environment", opencode: true });
    expect(JSON.parse((r as { text: string }).text).mcp["sap-ui-automation"]).toEqual({ type: "local", command: ["npx", "-y", "sap-ui-automation"], environment: { SAP_BROWSER: "extension" } });
    const there = addToJson((r as { text: string }).text, ["mcp", "servers"], { environment: { SAP_BROWSER: "extension" } }, true, { envKey: "environment", opencode: true });
    expect(there).toMatchObject({ kind: "present", missingEnv: [] });
  });

  test("OpenCode and Amp: the .jsonc file when there is one", () => {
    mk(".config", "opencode");
    mk(".config", "amp");
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "$schema": "https://opencode.ai/config.json",\n}\n');
    writeFileSync(join(home, ".config", "amp", "settings.jsonc"), "{}\n");
    setup({ dryRun: false, only: ["opencode", "amp"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(join(home, ".config", "opencode", "opencode.jsonc"))).toContain("// mine");
    expect(read(join(home, ".config", "opencode", "opencode.jsonc"))).toContain('"servers"');
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(read(join(home, ".config", "amp", "settings.jsonc"))).toContain('"amp.mcpServers"');
  });

  test("an old-named entry is flagged in any JSON agent", () => {
    mk(".kiro", "settings");
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "sap-gui-mcp-server": {} } }));
    const r = setup({ dryRun: false, only: ["kiro"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(r.lines.some((l) => l.includes('Also found "sap-gui-mcp-server"') && l.includes("mcp.json"))).toBe(true);
  });

  test("Goose: a new file; a file with other extensions keeps every line; there already; a form it does not read", () => {
    const cmd = ["npx", "-y", "sap-ui-automation"];
    const fresh = addToGoose("", cmd, {});
    expect(fresh.kind).toBe("add");
    expect((fresh as { text: string }).text).toBe(
      'extensions:\n  sap-ui-automation:\n    name: sap-ui-automation\n    type: stdio\n    enabled: true\n    cmd: "npx"\n    args: ["-y", "sap-ui-automation"]\n    envs: {}\n    env_keys: []\n    timeout: 300\n',
    );
    const mine = "GOOSE_PROVIDER: openai\n# my extensions\nextensions:\n    developer:\n        enabled: true\n        type: builtin\nGOOSE_MODEL: gpt-4o\n";
    const r = addToGoose(mine, cmd, { SAP_BROWSER: "extension" });
    const text = (r as { text: string }).text;
    expect(text).toStartWith("GOOSE_PROVIDER: openai\n# my extensions\nextensions:\n    sap-ui-automation:\n        name: sap-ui-automation\n");
    expect(text).toContain('        envs: { SAP_BROWSER: "extension" }\n');
    expect(text).toContain("    developer:\n        enabled: true\n        type: builtin\nGOOSE_MODEL: gpt-4o\n");
    expect(addToGoose(text, cmd, { SAP_BROWSER: "extension" })).toMatchObject({ kind: "present", missingEnv: [] });
    expect(addToGoose(text, cmd, { OTHER: "1" })).toMatchObject({ kind: "present", missingEnv: [["OTHER", "1"]] });
    expect(addToGoose("extensions: {}\n", cmd, {}).kind).toBe("error");
    expect(addToGoose("x: sap-ui-automation\n", cmd, {}).kind).toBe("error");
    expect(addToGoose("extensions:\n  sap-gui:\n    cmd: x\n", cmd, {})).toMatchObject({ kind: "add", old: ["sap-gui"] });
    // through setup, with the .bak
    mk(".config", "goose");
    writeFileSync(join(home, ".config", "goose", "config.yaml"), mine);
    setup({ dryRun: false, only: ["goose"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(join(home, ".config", "goose", "config.yaml"))).toContain("    sap-ui-automation:\n");
    expect(read(join(home, ".config", "goose", "config.yaml.bak"))).toBe(mine);
  });

  test("Claude Code: claude mcp add, or already there; the old names are flagged", () => {
    const calls: string[][] = [];
    let have = false;
    const claude = (args: string[]) => {
      calls.push(args);
      if (args[1] === "get") return { status: (args[2] === "sap-ui-automation" && have) || args[2] === "sap-gui" ? 0 : 1 };
      have = true;
      return { status: 0 };
    };
    const on = (c: string) => c === "claude";
    const r = setup({ dryRun: false, cwd, onPath: on, claude, skills: false }, {}, "linux", home);
    expect(calls.some((a) => a.slice(0, 5).join(" ") === "mcp add sap-ui-automation --scope user")).toBe(true);
    expect(r.lines).toContain("✓ Claude Code: server added for your user.");
    expect(r.lines.some((l) => l.includes('Also found "sap-gui"') && l.includes("claude mcp remove sap-gui"))).toBe(true);
    expect(setup({ dryRun: false, cwd, onPath: on, claude, skills: false }, {}, "linux", home).lines).toContain("✓ Claude Code: server already configured (claude mcp get sap-ui-automation).");
    // named but not installed: what to run, and no skills
    const missing = setup({ dryRun: false, only: ["claude-code"], cwd, onPath: none }, {}, "linux", home);
    expect(missing.lines.some((l) => l.startsWith("✗ Claude Code: no claude command"))).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

describe("the skills: one copy, links elsewhere", () => {
  const canonical = () => join(home, ".agents", "skills");
  const shipped = (name: string) => read(join(packageRoot(), "skills", name, "SKILL.md"));

  test("Claude Code, Gemini CLI, Codex: a copy in ~/.agents/skills, links in the others; a rerun keeps them", () => {
    mk(".codex");
    mk(".gemini");
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    const claude = () => ({ status: 0 });
    const r = setup({ dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
    for (const dir of [join(home, ".claude", "skills"), join(home, ".gemini", "skills")]) {
      const link = join(dir, "sap-ui-automation");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(canonical(), "sap-ui-automation")));
      expect(readlinkSync(link)).not.toStartWith("/"); // relative
      expect(read(join(link, "SKILL.md"))).toBe(shipped("sap-ui-automation"));
    }
    expect(lstatSync(join(canonical(), "sap-ui-automation")).isDirectory()).toBe(true);
    expect(r.lines).toContain(`✓ Claude Code: server already configured (claude mcp get sap-ui-automation); skills linked in ${sk(".claude", "skills")} → ${sk(".agents", "skills")}.`);
    expect(r.lines.some((l) => l.startsWith("✓ Codex:") && l.endsWith(`skills installed in ${sk(".agents", "skills")}.`))).toBe(true);
    const again = setup({ dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
    expect(again.lines).toContain(`✓ Claude Code: server already configured (claude mcp get sap-ui-automation); skills up to date in ${sk(".claude", "skills")} (linked).`);
    expect(again.lines).toContain("Next: ask your agent to look at your SAP screen.");
    // a new version: the copy is updated in place, the links stay
    writeFileSync(join(canonical(), "sap-ui-automation", "SKILL.md"), "older version");
    const update = setup({ dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
    expect(update.lines).toContain(`✓ Claude Code: server already configured (claude mcp get sap-ui-automation); skill sap-ui-automation updated in ${sk(".claude", "skills")} (linked); skill sap-ui-automation-cli up to date in ${sk(".claude", "skills")} (linked).`);
    expect(read(join(home, ".claude", "skills", "sap-ui-automation", "SKILL.md"))).toBe(shipped("sap-ui-automation"));
    expect(update.lines.find((l) => l.startsWith("Next:"))).toContain("restart Claude Code");
  });

  test("where no link can be made: a copy, said so; a rerun still updates it", () => {
    const fail = () => {
      throw new Error("EPERM");
    };
    const dir = join(home, ".kiro", "skills");
    const rs = setupSharedSkills([dir], { canonical: canonical(), dryRun: false, platform: "win32", link: fail });
    expect(rs[1]?.states).toEqual({ "sap-ui-automation": "copied", "sap-ui-automation-cli": "copied" });
    expect(lstatSync(join(dir, "sap-ui-automation")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, "sap-ui-automation", ".sap-ui-automation"))).toBe(true);
    mk(".kiro");
    const r = setup({ dryRun: false, only: ["kiro"], cwd, onPath: none, link: fail }, {}, "linux", home);
    expect(r.lines.some((l) => l.includes(`skills copied to ${sk(".kiro", "skills")} (a link could not be made there)`))).toBe(true);
  });

  test("a folder of ours under the name becomes a link; one that is not ours, or a link elsewhere, stays", () => {
    const dir = join(home, ".roo", "skills");
    mkdirSync(join(dir, "sap-ui-automation"), { recursive: true });
    writeFileSync(join(dir, "sap-ui-automation", "SKILL.md"), "old");
    writeFileSync(join(dir, "sap-ui-automation", ".sap-ui-automation"), "");
    mkdirSync(join(root, "mine", "sap-ui-automation-cli"), { recursive: true });
    writeFileSync(join(root, "mine", "sap-ui-automation-cli", "SKILL.md"), "---\nname: other\n---\n");
    symlinkSync(join(root, "mine", "sap-ui-automation-cli"), join(dir, "sap-ui-automation-cli"));
    const rs = setupSharedSkills([dir], { canonical: canonical(), dryRun: false, platform: "linux" });
    expect(rs[1]?.states).toEqual({ "sap-ui-automation": "linked", "sap-ui-automation-cli": "left" });
    expect(lstatSync(join(dir, "sap-ui-automation")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "sap-ui-automation-cli"))).toBe(join(root, "mine", "sap-ui-automation-cli"));
    // removing a link never touches what it points to
    expect(existsSync(join(canonical(), "sap-ui-automation", "SKILL.md"))).toBe(true);
  });

  test("a skills folder that is itself a link to ~/.agents/skills is written once, as the shared one", () => {
    mkdirSync(canonical(), { recursive: true });
    mk(".config");
    symlinkSync(canonical(), join(home, ".config", "agents-link"));
    const rs = setupSharedSkills([join(home, ".config", "agents-link"), canonical()], { canonical: canonical(), dryRun: false, platform: "linux" });
    expect(rs.map((r) => [r.dir, r.canonical])).toEqual([
      [canonical(), true],
      [join(home, ".config", "agents-link"), true],
    ]);
    expect(lstatSync(join(canonical(), "sap-ui-automation")).isDirectory()).toBe(true);
  });

  test("when the shared name is someone else's, the other folders get copies of their own", () => {
    mkdirSync(join(canonical(), "sap-ui-automation"), { recursive: true });
    writeFileSync(join(canonical(), "sap-ui-automation", "SKILL.md"), "someone else's");
    const dir = join(home, ".junie", "skills");
    const rs = setupSharedSkills([dir], { canonical: canonical(), dryRun: false, platform: "linux" });
    expect(rs[0]?.states["sap-ui-automation"]).toBe("left");
    expect(rs[1]?.states["sap-ui-automation"]).toBe("installed");
    expect(read(join(dir, "sap-ui-automation", "SKILL.md"))).toBe(shipped("sap-ui-automation"));
    expect(read(join(canonical(), "sap-ui-automation", "SKILL.md"))).toBe("someone else's");
  });
});

describe("dry run", () => {
  test("every agent found: says what it would do, writes nothing", () => {
    for (const p of [".codex", ".cursor", ".copilot", ".kiro", ".junie", ".warp", ".qwen", ".factory", ".roo", ".cline", ".config/zed", ".config/goose", ".config/amp", ".config/opencode", ".gemini/antigravity"]) mk(...p.split("/"));
    const before = () => readdirSync(home, { recursive: true }).map(String).sort();
    const was = before();
    const r = setup({ dryRun: true, cwd, onPath: none, extension: true, installHelper: () => { throw new Error("must not run"); } }, {}, "linux", home);
    expect(before()).toEqual(was);
    const agentLines = r.lines.filter((l) => /^[•✓✗] /.test(l) && !l.includes("Chrome"));
    expect(agentLines.length).toBe(15);
    expect(agentLines.every((l) => l.startsWith("• "))).toBe(true);
    expect(r.lines).toContain(`• Roo Code: skills would be linked in ${sk(".roo", "skills")} → ${sk(".agents", "skills")}.`);
    expect(r.lines.some((l) => l.startsWith("• Goose: would add the server to"))).toBe(true);
  });
});
