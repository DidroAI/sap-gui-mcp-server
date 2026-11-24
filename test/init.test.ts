import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, exampleTest, init } from "../src/cli/init.js";
import { detectClients, setup } from "../src/cli/setup.js";
import { cursorRule, installSkills, packageRoot, shippedSkills } from "../src/cli/skills.js";

// Every test gets its own HOME and project folder, and sees no command on PATH:
// nothing here may touch the real ~/.claude, ~/.codex or run `claude mcp add`.
let root: string;
let home: string;
let cwd: string;
const none = () => false;
const base = () => ({ cwd, home, env: {}, platform: "linux" as const, onPath: none });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sap-init-"));
  home = join(root, "home");
  cwd = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p));

describe("init", () => {
  test("--yes writes the config, the example, skills and .gitignore entries, one line per step", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules");
    const r = await init({ ...base(), yes: true });
    expect(read(join(cwd, "sap.config.ts"))).toContain('surface: "webgui"');
    expect(read(join(cwd, "sap.config.ts"))).toContain('write: "off"');
    expect(read(join(cwd, "sap-tests", "example.sap.ts"))).toContain('okcode("/nSU3")');
    // no client found: Claude Code's project skills still get installed
    expect(existsSync(join(cwd, ".claude", "skills", "sap-gui-drive", "SKILL.md"))).toBe(true);
    expect(read(join(cwd, ".gitignore"))).toBe("node_modules\n# sap-ui-automation: traces and test results hold screens of business data\n.sap-gui/\nsap-results/\n");
    expect(r.lines.some((l) => l.includes("MCP clients: none chosen"))).toBe(true);
    expect(r.lines.every((l) => !l.includes("\n"))).toBe(true);
    // a second run changes nothing
    const again = await init({ ...base(), yes: true });
    expect(again.lines.filter((l) => l.includes("skipped")).length).toBe(2);
    expect(again.lines.some((l) => l.includes("already ignores"))).toBe(true);
    expect(read(join(cwd, ".gitignore")).match(/sap-results/g)?.length).toBe(1);
  });

  test("a git project without a .gitignore gets one; a folder that is not a repository does not", async () => {
    await init({ ...base(), yes: true });
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
    mkdirSync(join(cwd, ".git"));
    const r = await init({ ...base(), yes: true });
    expect(read(join(cwd, ".gitignore"))).toBe("# sap-ui-automation: traces and test results hold screens of business data\n.sap-gui/\nsap-results/\n");
    expect(r.lines).toContain("✓ .gitignore: added .sap-gui/, sap-results/");
  });

  test("Windows defaults to SAP GUI and Web GUI", async () => {
    await init({ ...base(), platform: "win32", yes: true });
    expect(read(join(cwd, "sap.config.ts"))).toContain('surface: ["sapgui", "webgui"]');
  });

  test("existing files are skipped, and replaced with --force", async () => {
    writeFileSync(join(cwd, "sap.config.ts"), "// mine\n");
    const r = await init({ ...base(), yes: true });
    expect(read(join(cwd, "sap.config.ts"))).toBe("// mine\n");
    expect(r.lines).toContain("– sap.config.ts: exists, skipped (--force overwrites it)");
    const f = await init({ ...base(), yes: true, force: true });
    expect(read(join(cwd, "sap.config.ts"))).toContain("defineConfig");
    expect(f.lines).toContain("✓ sap.config.ts: overwritten");
  });

  test("--dry-run writes nothing", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(cwd, ".gitignore"), "");
    const r = await init({ ...base(), yes: true, dryRun: true });
    expect(existsSync(join(cwd, "sap.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, "sap-tests"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor"))).toBe(false);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(read(join(cwd, ".gitignore"))).toBe("");
    expect(r.lines).toContain("• sap.config.ts: would be written");
    expect(r.lines.some((l) => l.startsWith("• Cursor: would add"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("• .gitignore: would add"))).toBe(true);
  });

  test("the answers shape the files and pick the clients", async () => {
    mkdirSync(join(home, ".cursor"));
    const answers = ["webgui, fiori", "ABA/800", "confirm", "cursor"];
    const asked: string[] = [];
    const r = await init({ ...base(), ask: async (q) => (asked.push(q), answers.shift() ?? "") });
    expect(asked.length).toBe(4);
    expect(asked[3]).toContain("found: cursor");
    expect(r.answers).toEqual({ surfaces: ["webgui", "fiori"], system: "ABA/800", write: "confirm", clients: ["cursor"] });
    const config = read(join(cwd, "sap.config.ts"));
    expect(config).toContain('system: "ABA/800"');
    expect(config).toContain('write: "confirm"');
    expect(existsSync(join(cwd, ".cursor", "rules", "sap-gui-drive.mdc"))).toBe(true);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers["sap-ui-automation"].command).toBeString();
  });

  test("Enter keeps every default", async () => {
    const r = await init({ ...base(), ask: async () => "" });
    expect(r.answers).toEqual({ surfaces: ["webgui"], system: "", write: "off", clients: [] });
  });

  test("the example stays read-only, and Fiori gets its own", () => {
    for (const s of ["sapgui", "webgui", "fiori"] as const) expect(exampleTest(s)).not.toMatch(/\.(set|press|key)\(/);
    expect(exampleTest("fiori")).toContain('open("#Shell-home")');
    expect(configFile({ surfaces: ["fiori"], system: "", write: "off", clients: [] })).toContain('// system: "ABA/800"');
  });
});

describe("install --skills", () => {
  test("the package ships its skills, found from the module", () => {
    expect(existsSync(join(packageRoot(), "package.json"))).toBe(true);
    expect(shippedSkills().map((s) => s.name)).toContain("sap-gui-drive");
  });

  test("Claude Code: project and --global, idempotent", () => {
    const first = installSkills({ targets: ["claude"], cwd, home, env: {} });
    const file = join(cwd, ".claude", "skills", "sap-gui-drive", "SKILL.md");
    expect(read(file)).toBe(read(join(packageRoot(), "skills", "sap-gui-drive", "SKILL.md")));
    expect(first.lines.find((l) => l.includes("sap-gui-drive"))).toContain("created (.claude/skills/sap-gui-drive)");
    expect(installSkills({ targets: ["claude"], cwd, home, env: {} }).lines.find((l) => l.includes("sap-gui-drive"))).toContain("unchanged");
    writeFileSync(file, "old");
    expect(installSkills({ targets: ["claude"], cwd, home, env: {} }).lines.find((l) => l.includes("sap-gui-drive"))).toContain("updated");
    installSkills({ targets: ["claude"], global: true, cwd, home, env: {} });
    expect(existsSync(join(home, ".claude", "skills", "sap-gui-drive", "SKILL.md"))).toBe(true);
  });

  test("Codex: .agents/skills in the project, CODEX_HOME/skills with --global", () => {
    installSkills({ targets: ["codex"], cwd, home, env: {} });
    expect(existsSync(join(cwd, ".agents", "skills", "sap-gui-drive", "SKILL.md"))).toBe(true);
    installSkills({ targets: ["codex"], global: true, cwd, home, env: {} });
    expect(existsSync(join(home, ".codex", "skills", "sap-gui-drive", "SKILL.md"))).toBe(true);
    const codexHome = join(root, "codex");
    installSkills({ targets: ["codex"], global: true, cwd, home, env: { CODEX_HOME: codexHome } });
    expect(existsSync(join(codexHome, "skills", "sap-gui-drive", "SKILL.md"))).toBe(true);
  });

  test("Cursor: a .mdc rule picked by description; no user-level rules", () => {
    installSkills({ targets: ["cursor"], cwd, home, env: {} });
    const rule = read(join(cwd, ".cursor", "rules", "sap-gui-drive.mdc"));
    expect(rule).toStartWith("---\ndescription: Work in SAP screens");
    expect(rule).toContain("\nalwaysApply: false\n---\n");
    expect(rule).not.toContain("name: sap-gui-drive");
    expect(rule).toContain("# Working in SAP screens");
    const g = installSkills({ targets: ["cursor"], global: true, cwd, home, env: {} });
    expect(g.lines[0]).toContain("no user-level rule files");
  });

  test("dry run reports without writing", () => {
    const r = installSkills({ targets: ["claude", "codex", "cursor"], dryRun: true, cwd, home, env: {} });
    expect(r.lines.length).toBe(3 * shippedSkills().length);
    expect(r.lines.every((l) => l.includes("would be created"))).toBe(true);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  test("cursorRule keeps the body of a file without frontmatter", () => {
    expect(cursorRule("# Hi\n")).toBe("---\ndescription: \nglobs:\nalwaysApply: false\n---\n# Hi\n");
  });
});

describe("setup: Cursor, Windsurf, VS Code", () => {
  test("Cursor: the user's mcp.json, or the project's when it has one; never twice", () => {
    mkdirSync(join(home, ".cursor"));
    expect(detectClients({ cwd, onPath: none }, {}, "linux", home)).toEqual(["cursor"]);
    const r = setup({ dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    expect(r.changed).toBe(1);
    expect(Object.keys(json(join(home, ".cursor", "mcp.json")).mcpServers)).toEqual(["sap-ui-automation"]);
    expect(setup({ dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.includes("already in"))).toBe(true);

    mkdirSync(join(cwd, ".cursor"));
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    setup({ dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    const project = json(join(cwd, ".cursor", "mcp.json"));
    expect(Object.keys(project.mcpServers)).toEqual(["other", "sap-ui-automation"]);
    expect(existsSync(join(cwd, ".cursor", "mcp.json.bak"))).toBe(true);
  });

  test("Cursor: dry run and not found", () => {
    expect(setup({ dryRun: false, only: [], cwd, onPath: none }, {}, "linux", home).lines).toContain("– Cursor: not found (no ~/.cursor, no .cursor/mcp.json here).");
    mkdirSync(join(home, ".cursor"));
    const r = setup({ dryRun: true, cwd, onPath: none }, {}, "linux", home);
    expect(r.lines.some((l) => l.startsWith("• Cursor: would add"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("a broken mcp.json is reported, not overwritten", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{oops");
    const r = setup({ dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    expect(r.lines.some((l) => l.startsWith("✗ Cursor:") && l.includes("not valid JSON"))).toBe(true);
    expect(read(join(home, ".cursor", "mcp.json"))).toBe("{oops");
  });

  test("Windsurf (Devin Desktop): writes ~/.config/devin/mcp_config.json, found by the old folder too", async () => {
    const file = join(home, ".config", "devin", "mcp_config.json");
    expect(setup({ dryRun: false, cwd, onPath: none }, {}, "linux", home).lines).toContain("– Windsurf (Devin Desktop): not found.");
    // An older Windsurf: its folder says it is installed; the server goes to the file it reads now.
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    expect(detectClients({ cwd, onPath: none }, {}, "linux", home)).toEqual(["windsurf"]);
    expect(setup({ dryRun: true, cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.startsWith("• Windsurf (Devin Desktop): would add"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    const r = await init({ ...base(), yes: true });
    expect(r.lines.some((l) => l.startsWith('✓ Windsurf (Devin Desktop): added "sap-ui-automation"'))).toBe(true);
    expect(json(file).mcpServers["sap-ui-automation"].args).toBeArray();
    expect(existsSync(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(false);
  });

  test("Windsurf (Devin Desktop): XDG_CONFIG_HOME and %APPDATA%", () => {
    mkdirSync(join(home, "xdg", "devin"), { recursive: true });
    setup({ dryRun: false, cwd, onPath: none, only: ["windsurf"] }, { XDG_CONFIG_HOME: join(home, "xdg") }, "linux", home);
    expect(json(join(home, "xdg", "devin", "mcp_config.json")).mcpServers["sap-ui-automation"]).toBeDefined();
    setup({ dryRun: false, cwd, onPath: none, only: ["windsurf"] }, { APPDATA: join(home, "AppData") }, "win32", home);
    expect(json(join(home, "AppData", "devin", "mcp_config.json")).mcpServers["sap-ui-automation"]).toBeDefined();
  });

  test("VS Code: only a project that has .vscode/mcp.json, under `servers`", () => {
    expect(setup({ dryRun: false, cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.includes("VS Code"))).toBe(false);
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), "{}");
    setup({ dryRun: false, cwd, onPath: none }, {}, "linux", home);
    expect(json(join(cwd, ".vscode", "mcp.json")).servers["sap-ui-automation"].type).toBe("stdio");
  });
});
