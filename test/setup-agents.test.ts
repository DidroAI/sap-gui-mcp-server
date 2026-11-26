import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, AGENTS, type Ctx, detectAgents, selectAgents } from "../src/cli/agents.js";
import { addToGoose, addToJson, jsonEntry, setJsonEnv } from "../src/cli/mcp-config.js";
import { type Choice, pickKey, renderPick } from "../src/cli/prompt.js";
import { claudeEntry, codexSetEnv, fitNames, parseSetupArgs, setup, setupCommand } from "../src/cli/setup.js";
import { packageRoot, setupSharedSkills } from "../src/cli/skills.js";
import { useColor } from "../src/cli/style.js";

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

  const run = async (args: string[], tty: boolean, pick?: (c: Choice[], initial: string[]) => Promise<string[] | undefined>) => {
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
    expect(out.filter((l) => l.includes("Codex, Kiro"))).toEqual(["Agents found: Codex, Kiro.", "✓ Server and skills  Codex, Kiro"]);
    expect(existsSync(join(home, ".kiro", "settings", "mcp.json"))).toBe(true);
    expect(out).toContain("  1. Restart your agent apps (a new Codex session).");
  });

  test("a terminal: the picker lists the agents found first, ticked, then the others under Not found; one line replaces it", async () => {
    mk(".codex");
    mk(".roo");
    let seen: { choices: Choice[]; initial: string[] } | undefined;
    const { out } = await run([], true, async (choices, initial) => ((seen = { choices, initial }), ["kiro"]));
    const ids = seen?.choices.map((c) => c.value) ?? [];
    expect(ids.slice(0, 2)).toEqual(["codex", "roo"]);
    expect(ids.slice(2)).toEqual(AGENT_IDS.filter((id) => id !== "codex" && id !== "roo"));
    expect(seen?.choices.slice(0, 2).map((c) => c.group)).toEqual([undefined, undefined]);
    expect(seen?.choices.slice(2).every((c) => c.group === "Not found")).toBe(true);
    // no "found" word; "skills only" stays, as a hint
    expect(seen?.choices.find((c) => c.value === "roo")).toEqual({ value: "roo", label: "Roo Code", hint: "skills only" });
    expect(seen?.choices.find((c) => c.value === "codex")).toEqual({ value: "codex", label: "Codex" });
    expect(seen?.initial).toEqual(["codex", "roo"]);
    expect(out.some((l) => l.startsWith("Agents found"))).toBe(false);
    expect(out[0]).toBe("✓ 1 agent selected");
    expect(existsSync(join(home, ".kiro", "settings", "mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("--yes and --agent skip the picker; cancelling or ticking nothing changes nothing", async () => {
    mk(".codex");
    const ask = async () => {
      throw new Error("must not ask");
    };
    expect((await run(["--yes", "--dry-run"], true, ask)).out[0]).toBe("Agents found: Codex.");
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
    const choices: Choice[] = [{ value: "a", label: "A" }, { value: "b", label: "B", hint: "skills only", group: "Not found" }, { value: "c", label: "C", group: "Not found" }];
    expect(renderPick("Pick", choices, { cursor: 1, checked: [true, false, false] })).toEqual(["Pick  (↑/↓ move, space select, a all, Enter confirm)", "  ◉ A", "  Not found", "❯ ◯ B  skills only", "  ◯ C"]);
    // in colour: the group, the hint and the keys dim, a ticked box green
    expect(renderPick("Pick", choices, { cursor: 1, checked: [true, false, false] }, true)).toEqual([
      "Pick  \x1b[2m(↑/↓ move, space select, a all, Enter confirm)\x1b[22m",
      "  \x1b[32m◉\x1b[39m A",
      "\x1b[2m  Not found\x1b[22m",
      "❯ ◯ B  \x1b[2mskills only\x1b[22m",
      "  ◯ C",
    ]);
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
      const go = () => viaNpx(() => setup({ verbose: true, dryRun: false, only: [c.id], cwd, onPath: none, skills: false }, {}, platform, home));
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
    setup({ verbose: true, dryRun: false, only: ["opencode", "amp"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(join(home, ".config", "opencode", "opencode.jsonc"))).toContain("// mine");
    expect(read(join(home, ".config", "opencode", "opencode.jsonc"))).toContain('"servers"');
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(read(join(home, ".config", "amp", "settings.jsonc"))).toContain('"amp.mcpServers"');
  });

  test("an old-named entry is flagged in any JSON agent", () => {
    mk(".kiro", "settings");
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "sap-gui-mcp-server": {} } }));
    const r = setup({ verbose: true, dryRun: false, only: ["kiro"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(r.lines).toContain('! "sap-gui-mcp-server", this server\'s name before 0.1.0, is still there: the agent gets its tools twice. Remove it:');
    expect(r.lines).toContain(`    Kiro: delete "sap-gui-mcp-server" under "mcpServers" in ${sk(".kiro", "settings", "mcp.json")}`);
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
    setup({ verbose: true, dryRun: false, only: ["goose"], cwd, onPath: none, skills: false }, {}, "linux", home);
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
    const r = setup({ verbose: true, dryRun: false, cwd, onPath: on, claude, skills: false }, {}, "linux", home);
    expect(calls.some((a) => a.slice(0, 5).join(" ") === "mcp add sap-ui-automation --scope user")).toBe(true);
    expect(r.lines).toContain("✓ Claude Code: server added for your user.");
    expect(r.lines).toContain("    Claude Code: claude mcp remove sap-gui");
    expect(setup({ verbose: true, dryRun: false, cwd, onPath: on, claude, skills: false }, {}, "linux", home).lines).toContain("✓ Claude Code: server already configured (claude mcp get sap-ui-automation).");
    // named but not installed: what to run, and no skills
    const missing = setup({ verbose: true, dryRun: false, only: ["claude-code"], cwd, onPath: none }, {}, "linux", home);
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
    const r = setup({ verbose: true, dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
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
    const again = setup({ verbose: true, dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
    expect(again.lines).toContain(`✓ Claude Code: server already configured (claude mcp get sap-ui-automation); skills up to date in ${sk(".claude", "skills")} (linked).`);
    expect(again.lines.some((l) => l.includes("Restart"))).toBe(false);
    expect(again.lines).toContain("  1. Ask your agent to look at your SAP screen. For Web GUI and Fiori, log on once in the Chrome window it opens.");
    // a new version: the copy is updated in place, the links stay
    writeFileSync(join(canonical(), "sap-ui-automation", "SKILL.md"), "older version");
    const update = setup({ verbose: true, dryRun: false, cwd, onPath: (c) => c === "claude", claude }, {}, "linux", home);
    expect(update.lines).toContain(`✓ Claude Code: server already configured (claude mcp get sap-ui-automation); skill sap-ui-automation updated in ${sk(".claude", "skills")} (linked); skill sap-ui-automation-cli up to date in ${sk(".claude", "skills")} (linked).`);
    expect(read(join(home, ".claude", "skills", "sap-ui-automation", "SKILL.md"))).toBe(shipped("sap-ui-automation"));
    expect(update.lines).toContain("  1. Restart your agent apps (a new Codex session).");
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
    const r = setup({ verbose: true, dryRun: false, only: ["kiro"], cwd, onPath: none, link: fail }, {}, "linux", home);
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
    const r = setup({ verbose: true, dryRun: true, cwd, onPath: none, extension: true, installHelper: () => { throw new Error("must not run"); } }, {}, "linux", home);
    expect(before()).toEqual(was);
    const agentLines = r.lines.filter((l) => /^[•✓✗] /.test(l) && !l.includes("Chrome"));
    expect(agentLines.length).toBe(15);
    expect(agentLines.every((l) => l.startsWith("• "))).toBe(true);
    expect(r.lines).toContain(`• Roo Code: skills would be linked in ${sk(".roo", "skills")} → ${sk(".agents", "skills")}.`);
    expect(r.lines.some((l) => l.startsWith("• Goose: would add the server to"))).toBe(true);
  });
});

describe("the summary", () => {
  const codexToml = '# mine\n[mcp_servers.sap-ui-automation]\ncommand = "npx"\nargs = ["-y", "sap-ui-automation"]\n\n[mcp_servers.other]\ncommand = "x"\nenv = { A = "1" }\n';
  const many = () => {
    for (const p of [".codex", ".cursor", ".copilot", ".kiro", ".roo", ".continue", ".trae", ".config/crush"]) mk(...p.split("/"));
  };

  test("the agents are grouped by what they got; counts instead of paths; short names", () => {
    many();
    mk(".codeium", "windsurf");
    const r = setup({ dryRun: false, cwd, onPath: none }, {}, "linux", home);
    expect(r.lines.slice(0, 5)).toEqual([
      "✓ Server and skills  Codex, Cursor, Windsurf, Copilot CLI, Kiro",
      "✓ Skills only        Roo Code, Crush, Continue, Trae",
      "  Server added for 5 agents",
      `  Skills installed in ${sk(".agents", "skills")}, linked for 6 agents`,
      "",
    ]);
    // no per-agent paths, no "Command for MCP clients", no "Needs your attention" when nothing needs it
    expect(r.lines.some((l) => l.includes("config.toml") || l.includes("Command for MCP clients") || l.includes("Needs your attention"))).toBe(false);
    expect(r.lines.slice(5)).toEqual([
      "Next",
      "  1. Restart your agent apps (a new Codex session; Cursor and Windsurf: reload MCP servers).",
      "  2. Ask your agent to look at your SAP screen. For Web GUI and Fiori, log on once in the Chrome window it opens.",
      "  3. Not working? npx -y sap-ui-automation doctor",
    ]);
    const again = setup({ dryRun: false, cwd, onPath: none }, {}, "linux", home);
    expect(again.lines).toContain("  Server already there for 5");
    expect(again.lines).toContain(`  Skills up to date in ${sk(".agents", "skills")}, linked for 6 agents`);
  });

  test("a long group is cut to fit, with the count; server only; skipped and failed agents are named", () => {
    expect(fitNames(["Claude Code", "Codex", "Cursor", "Windsurf", "Copilot CLI", "Gemini CLI", "Antigravity", "OpenCode", "Cline", "Kiro", "Junie", "Qwen Code", "Factory Droid"], 72)).toBe("Claude Code, Codex, Cursor, Windsurf, Copilot CLI, Gemini CLI, … (13)");
    expect(fitNames(["A", "B"], 72)).toBe("A, B");
    mk(".cursor");
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    const r = setup({ dryRun: false, only: ["claude-desktop", "roo", "cursor", "kiro"], cwd, onPath: none, skills: false }, { APPDATA: join(home, "AppData") }, "win32", home);
    expect(r.lines).toContain("✓ Server only        Claude Desktop, Kiro");
    expect(r.lines).toContain("✗ Not set up         Cursor");
    expect(r.lines).toContain("– Skipped            Roo Code (no MCP config known, --no-skills)");
    // the failure is said in full under "Needs your attention"
    const at = r.lines.indexOf("Needs your attention");
    expect(at).toBeGreaterThan(0);
    expect(r.lines[at + 1]).toStartWith("✗ Cursor: ");
    expect(r.lines[at + 1]).toContain("is not valid JSON; add this under \"mcpServers\" by hand");
  });

  test("--dry-run: the same layout, with would; nothing written", () => {
    many();
    const was = readdirSync(home, { recursive: true }).map(String).sort();
    const r = setup({ dryRun: true, cwd, onPath: none, extension: true, installHelper: () => { throw new Error("must not run"); } }, {}, "linux", home);
    expect(readdirSync(home, { recursive: true }).map(String).sort()).toEqual(was);
    expect(r.lines.slice(0, 7)).toEqual([
      "Dry run: nothing is written. Setup would do this:",
      "",
      "• Server and skills  Codex, Cursor, Copilot CLI, Kiro",
      "• Skills only        Roo Code, Crush, Continue, Trae",
      "  Server would be added for 4 agents",
      `  Skills would be installed in ${sk(".agents", "skills")}, linked for 6 agents`,
      "• Chrome helper      would be installed",
    ]);
    expect(r.lines.slice(-3)).toEqual(["", "Next", "  1. Run it again without --dry-run to make these changes."]);
  });

  test("the old skill names are one counted line; --verbose names each folder", () => {
    mk(".codex");
    mk(".kiro");
    for (const d of [join(home, ".agents", "skills"), join(home, ".kiro", "skills")])
      for (const n of ["sap-gui-drive", "sap-gui-cli"]) {
        mkdirSync(join(d, n), { recursive: true });
        writeFileSync(join(d, n, ".sap-ui-automation"), "");
      }
    const r = setup({ dryRun: true, cwd, onPath: none }, {}, "linux", home);
    expect(r.lines).toContain("  Would remove the skills' old names (sap-gui-drive, sap-gui-cli) in 2 folders");
    const v = setup({ dryRun: false, cwd, onPath: none, verbose: true }, {}, "linux", home);
    expect(v.lines).toContain(`  Removed the skills' old names sap-gui-drive, sap-gui-cli in ${sk(".agents", "skills")}.`);
    expect(v.lines).toContain(`  Removed the skills' old names sap-gui-drive, sap-gui-cli in ${sk(".kiro", "skills")}.`);
  });

  test("Needs your attention: old names, grouped by name, with each agent's remove command", () => {
    mk(".kiro", "settings");
    mk(".qwen");
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "sap-gui": {} } }));
    writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ mcpServers: { "sap-gui": {}, "sap-gui-mcp-server": {} } }));
    const claude = (args: string[]) => ({ status: args[1] === "get" && args[2] === "sap-gui" ? 0 : args[1] === "add" ? 0 : 1 });
    const r = setup({ dryRun: false, cwd, onPath: (c) => c === "claude", claude, skills: false }, {}, "linux", home);
    const at = r.lines.indexOf("Needs your attention");
    expect(r.lines.slice(at - 1, at + 8)).toEqual([
      "",
      "Needs your attention",
      "! \"sap-gui-mcp-server\", this server's name before 0.1.0, is still there: the agent gets its tools twice. Remove it:",
      `    Qwen Code: delete "sap-gui-mcp-server" under "mcpServers" in ${sk(".qwen", "settings.json")}`,
      "! \"sap-gui\", this server's name before 0.1.0, is still there: the agent gets its tools twice. Remove it:",
      "    Claude Code: claude mcp remove sap-gui",
      `    Kiro: delete "sap-gui" under "mcpServers" in ${sk(".kiro", "settings", "mcp.json")}`,
      `    Qwen Code: delete "sap-gui" under "mcpServers" in ${sk(".qwen", "settings.json")}`,
      "",
    ]);
  });

  test("setupCommand: --verbose gives one line per agent; the default does not", async () => {
    mk(".codex");
    const go = async (args: string[]) => {
      const out: string[] = [];
      await setupCommand(args, { out: (l) => out.push(l), tty: false, home, env: {}, platform: "linux", options: { cwd, onPath: none } });
      return out;
    };
    const v = await go(["--verbose", "--dry-run"]);
    expect(v.some((l) => l.startsWith("• Codex: would add the server to"))).toBe(true);
    expect(v.some((l) => l.startsWith("Command for MCP clients"))).toBe(true);
    const short = await go(["--dry-run"]);
    expect(short.some((l) => l.startsWith("• Codex:"))).toBe(false);
    expect(short).toContain("• Server and skills  Codex");
    expect(parseSetupArgs(["-v"])).toMatchObject({ verbose: true });
  });
});

describe("colour", () => {
  test("on: a green ✓, a yellow !, dim secondary text; off: plain text, the same words", () => {
    mk(".codex");
    mk(".kiro", "settings");
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "sap-gui": {} } }));
    const plain = setup({ dryRun: false, cwd, onPath: none, skills: false }, {}, "linux", home).lines;
    expect(plain.join("\n")).not.toContain("\x1b[");
    rmSync(join(home, ".codex", "config.toml"));
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "sap-gui": {} } }));
    const color = setup({ dryRun: false, cwd, onPath: none, skills: false, color: true }, {}, "linux", home).lines;
    expect(color[0]).toBe("\x1b[32m✓\x1b[39m Server only        Codex, Kiro");
    expect(color).toContain("\x1b[2m  Server added for 2 agents\x1b[22m");
    expect(color.some((l) => l.startsWith("\x1b[33m!\x1b[39m "))).toBe(true);
    expect(color).toContain("\x1b[1mNeeds your attention\x1b[22m");
    // without the escapes, the same text
    expect(color.map((l) => l.replace(/\x1b\[\d+m/g, ""))).toEqual(plain);
  });

  test("only on a terminal, and not with NO_COLOR or TERM=dumb", () => {
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(useColor({}, {})).toBe(false);
    expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(useColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  });
});

describe("--extension: an existing entry of ours is switched to the extension", () => {
  const ext = { SAP_BROWSER: "extension" };

  test("JSON: SAP_BROWSER added to its env; the user's other variables, fields and servers untouched", () => {
    const text = '{\n  // mine\n  "mcpServers": {\n    "github": { "command": "gh", "env": { "TOKEN": "t" } },\n    "sap-ui-automation": {\n      "command": "npx",\n      "args": ["-y", "sap-ui-automation"],\n      "env": {\n        "SAP_WRITE": "confirm"\n      },\n      "disabled": false\n    }\n  }\n}\n';
    const r = setJsonEnv(text, ["mcpServers"], ext, true);
    expect(r).toEqual({ kind: "set", text: text.replace('"SAP_WRITE": "confirm"\n', '"SAP_WRITE": "confirm",\n        "SAP_BROWSER": "extension"\n') });
    // no env yet: one is added after the last field
    const bare = '{\n  "mcpServers": {\n    "sap-ui-automation": {\n      "command": "npx"\n    }\n  }\n}\n';
    expect(setJsonEnv(bare, ["mcpServers"], ext, false)).toEqual({ kind: "set", text: '{\n  "mcpServers": {\n    "sap-ui-automation": {\n      "command": "npx",\n      "env": {\n        "SAP_BROWSER": "extension"\n      }\n    }\n  }\n}\n' });
    // an entry on one line stays on one line
    const inline = '{\n  "mcpServers": {\n    "sap-ui-automation": { "command": "npx", "env": { "A": "1" } }\n  }\n}\n';
    expect(setJsonEnv(inline, ["mcpServers"], ext, false)).toEqual({ kind: "set", text: inline.replace('{ "A": "1" }', '{ "A": "1", "SAP_BROWSER": "extension" }') });
    // there already; set to something else (left); not an object (left)
    expect(setJsonEnv('{"mcpServers":{"sap-ui-automation":{"env":{"SAP_BROWSER":"extension"}}}}', ["mcpServers"], ext, false)).toEqual({ kind: "same" });
    expect(setJsonEnv('{"mcpServers":{"sap-ui-automation":{"env":{"SAP_BROWSER":"cdp"}}}}', ["mcpServers"], ext, false)).toEqual({ kind: "conflict", key: "SAP_BROWSER", value: "cdp" });
    expect(setJsonEnv('{"mcpServers":{"sap-ui-automation":{"env":"x"}}}', ["mcpServers"], ext, false).kind).toBe("error");
    // OpenCode: "environment", in the older form too
    const oc = JSON.stringify({ mcp: { "sap-ui-automation": { type: "local", command: ["npx"] } } });
    expect(JSON.parse((setJsonEnv(oc, ["mcp", "servers"], ext, true, { envKey: "environment", opencode: true }) as { text: string }).text).mcp["sap-ui-automation"].environment).toEqual(ext);
  });

  test("JSON through setup: switched, said so, counted; a .bak kept; a rerun leaves it", () => {
    mk(".cursor");
    mk(".kiro", "settings");
    const cursor = join(home, ".cursor", "mcp.json");
    const before = JSON.stringify({ mcpServers: { other: { command: "o", env: { K: "v" } }, "sap-ui-automation": { command: "npx", args: ["-y", "sap-ui-automation"], env: { SAP_WRITE: "off" }, timeout: 9 } } }, null, 2);
    writeFileSync(cursor, before);
    const dry = setup({ dryRun: true, only: ["cursor"], cwd, onPath: none, extension: true, skills: false }, {}, "linux", home);
    expect(dry.lines).toContain("  Server would be switched to the extension for Cursor");
    expect(read(cursor)).toBe(before);
    const r = setup({ dryRun: false, only: ["cursor"], cwd, onPath: none, extension: true, skills: false, installHelper: () => ({ hostDir: "/h", launcher: "/h/x", registered: ["x"] }) }, {}, "linux", home);
    expect(r.changed).toBe(1);
    expect(r.lines).toContain("  Server switched to the extension for Cursor");
    expect(r.lines).toContain("  1. Restart your agent apps (Cursor: reload MCP servers).");
    expect(json(cursor)).toEqual({ mcpServers: { other: { command: "o", env: { K: "v" } }, "sap-ui-automation": { command: "npx", args: ["-y", "sap-ui-automation"], env: { SAP_WRITE: "off", SAP_BROWSER: "extension" }, timeout: 9 } } });
    expect(read(`${cursor}.bak`)).toBe(before);
    const after = read(cursor);
    const again = setup({ dryRun: false, only: ["cursor"], cwd, onPath: none, extension: true, skills: false, installHelper: () => ({ hostDir: "/h", launcher: "/h/x", registered: ["x"] }) }, {}, "linux", home);
    expect(again.lines).toContain("  Server already there for 1");
    expect(read(cursor)).toBe(after);
    // without --extension, nothing is switched
    writeFileSync(cursor, before);
    setup({ dryRun: false, only: ["cursor"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(cursor)).toBe(before);
  });

  test("TOML: into the inline env, the env sub-table, or a new env line; every other line kept", () => {
    const head = '# mine\n[mcp_servers.sap-ui-automation]\ncommand = "npx"\nargs = ["-y", "sap-ui-automation"]\n';
    const tail = '\n[mcp_servers.other]\ncommand = "x"\nenv = { A = "1" }\n';
    expect(codexSetEnv(`${head}${tail}`, ext)).toEqual({ kind: "set", text: `${head}env = { SAP_BROWSER = "extension" }\n${tail}` });
    expect(codexSetEnv(`${head}env = { SAP_WRITE = "off" } # keep\n${tail}`, ext)).toEqual({ kind: "set", text: `${head}env = { SAP_WRITE = "off", SAP_BROWSER = "extension" } # keep\n${tail}` });
    expect(codexSetEnv(`${head}env = {}\n`, ext)).toEqual({ kind: "set", text: `${head}env = { SAP_BROWSER = "extension" }\n` });
    const sub = `${head}\n[mcp_servers.sap-ui-automation.env]\nSAP_WRITE = "off"\n${tail}`;
    expect(codexSetEnv(sub, ext)).toEqual({ kind: "set", text: sub.replace('SAP_WRITE = "off"\n', 'SAP_WRITE = "off"\nSAP_BROWSER = "extension"\n') });
    expect(codexSetEnv(`${head}env = { SAP_BROWSER = "extension" }\n`, ext)).toEqual({ kind: "same" });
    expect(codexSetEnv(`${head}env = { SAP_BROWSER = 'cdp' }\n`, ext)).toEqual({ kind: "conflict", key: "SAP_BROWSER", value: "cdp" });
    // forms it does not change
    expect(codexSetEnv('[mcp_servers]\nsap-ui-automation = { command = "npx" }\n', ext).kind).toBe("error");
    expect(codexSetEnv(`${head}env.SAP_WRITE = "off"\n`, ext).kind).toBe("error");
    expect(codexSetEnv(`${head}env = {\n`, ext).kind).toBe("error");
  });

  test("TOML through setup: switched; another server's env untouched", () => {
    mk(".codex");
    const file = join(home, ".codex", "config.toml");
    const before = '# mine\n[mcp_servers.sap-ui-automation]\ncommand = "npx"\nargs = ["-y", "sap-ui-automation"]\n\n[mcp_servers.other]\ncommand = "x"\nenv = { A = "1" }\n';
    writeFileSync(file, before);
    const r = setup({ dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, skills: false, verbose: true, installHelper: () => ({ hostDir: "/h", launcher: "/h/x", registered: ["x"] }) }, {}, "linux", home);
    expect(r.lines).toContain(`✓ Codex: SAP_BROWSER=extension added to its entry in ${sk(".codex", "config.toml")}.`);
    expect(read(file)).toBe(before.replace('"sap-ui-automation"]\n', '"sap-ui-automation"]\nenv = { SAP_BROWSER = "extension" }\n'));
  });

  test("what setup does not change is left, and named under Needs your attention", () => {
    mk(".config", "goose");
    mk(".kiro", "settings");
    mk(".codex");
    const goose = join(home, ".config", "goose", "config.yaml");
    const gooseText = "extensions:\n  sap-ui-automation:\n    cmd: npx\n    envs: {}\n";
    writeFileSync(goose, gooseText);
    const kiro = join(home, ".kiro", "settings", "mcp.json");
    const kiroText = JSON.stringify({ mcpServers: { "sap-ui-automation": { command: "npx", env: { SAP_BROWSER: "cdp" } } } });
    writeFileSync(kiro, kiroText);
    const codex = join(home, ".codex", "config.toml");
    const codexText = '[mcp_servers]\nsap-ui-automation = { command = "npx" }\n';
    writeFileSync(codex, codexText);
    const r = setup({ dryRun: false, cwd, onPath: none, extension: true, skills: false, installHelper: () => ({ hostDir: "/h", launcher: "/h/x", registered: ["x"] }) }, {}, "linux", home);
    expect(read(goose)).toBe(gooseText);
    expect(read(kiro)).toBe(kiroText);
    expect(read(codex)).toBe(codexText);
    expect(r.changed).toBe(0);
    const at = r.lines.indexOf("! Entries without SAP_BROWSER=extension that setup does not change:");
    expect(r.lines.slice(at + 1, at + 4)).toEqual([
      `    Codex: ${sk(".codex", "config.toml")} has "sap-ui-automation" in a form setup does not change; add SAP_BROWSER = "extension" to its env by hand`,
      `    Kiro: its entry sets SAP_BROWSER="cdp"; set it to "extension" in ${sk(".kiro", "settings", "mcp.json")}`,
      `    Goose: add SAP_BROWSER: extension under envs in ${sk(".config", "goose", "config.yaml")}`,
    ]);
  });

  test("Claude Code: read with claude mcp get; without the variable, the exact command, keeping its env", () => {
    const get = (env: string) => `sap-ui-automation:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: npx\n  Args: -y sap-ui-automation\n${env}\nTo remove this server, run: claude mcp remove sap-ui-automation -s user\n`;
    expect(claudeEntry(get("  Environment:\n    SAP_WRITE=confirm\n    NOTE=a b\n"))).toEqual({ command: "npx", args: ["-y", "sap-ui-automation"], env: { SAP_WRITE: "confirm", NOTE: "a b" }, remove: "claude mcp remove sap-ui-automation -s user" });
    let out = get("  Environment:\n    SAP_WRITE=confirm\n    NOTE=a b\n");
    const calls: string[][] = [];
    const claude = (args: string[]) => (calls.push(args), args[1] === "get" && args[2] === "sap-ui-automation" ? { status: 0, stdout: out } : { status: 1 });
    const go = () => setup({ dryRun: false, cwd, onPath: (c) => c === "claude", claude, extension: true, skills: false, installHelper: () => ({ hostDir: "/h", launcher: "/h/x", registered: ["x"] }) }, {}, "linux", home);
    const r = go();
    expect(r.lines).toContain("    Claude Code: re-add it with SAP_BROWSER=extension: claude mcp remove sap-ui-automation -s user && claude mcp add sap-ui-automation --scope user -e SAP_WRITE=confirm -e 'NOTE=a b' -e SAP_BROWSER=extension -- npx -y sap-ui-automation");
    // it never removes or adds by itself
    expect(calls.every((a) => a[1] === "get")).toBe(true);
    out = get("  Environment:\n    SAP_BROWSER=extension\n");
    expect(go().lines.some((l) => l.includes("SAP_BROWSER"))).toBe(false);
    // an answer it cannot read: what to check
    out = "something else";
    expect(go().lines.some((l) => l.startsWith("    Claude Code: check its env with claude mcp get sap-ui-automation"))).toBe(true);
  });
});
