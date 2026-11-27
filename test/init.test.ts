import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, exampleTest, init } from "../src/cli/init.js";
import { codexTable, detectClients, setup } from "../src/cli/setup.js";
import { cursorRule, installSkills, packageRoot, readIfThere, shippedSkills } from "../src/cli/skills.js";

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
    expect(existsSync(join(cwd, ".claude", "skills", "sap-ui-automation", "SKILL.md"))).toBe(true);
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

  test("an edited skill or Cursor rule is kept, and replaced with --force", async () => {
    // No client found: Claude Code's project skill.
    await init({ ...base(), yes: true });
    const skill = join(cwd, ".claude", "skills", "sap-ui-automation", "SKILL.md");
    writeFileSync(skill, "mine");
    const r = await init({ ...base(), yes: true });
    expect(read(skill)).toBe("mine");
    expect(r.lines).toContain(`– Claude Code skill sap-ui-automation: differs, kept (--force replaces it) (${join(".claude", "skills", "sap-ui-automation")})`);
    const f = await init({ ...base(), yes: true, force: true });
    expect(read(skill)).toBe(read(join(packageRoot(), "skills", "sap-ui-automation", "SKILL.md")));
    expect(f.lines.some((l) => l.startsWith("• Claude Code skill sap-ui-automation: updated"))).toBe(true);
    // Cursor found: its rule.
    mkdirSync(join(home, ".cursor"));
    await init({ ...base(), yes: true });
    const rule = join(cwd, ".cursor", "rules", "sap-ui-automation.mdc");
    writeFileSync(rule, "my rule");
    const c = await init({ ...base(), yes: true });
    expect(read(rule)).toBe("my rule");
    expect(c.lines.some((l) => l.startsWith("– Cursor skill sap-ui-automation: differs, kept"))).toBe(true);
    await init({ ...base(), yes: true, force: true });
    expect(read(rule)).toStartWith("---\ndescription:");
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
    expect(existsSync(join(cwd, ".cursor", "rules", "sap-ui-automation.mdc"))).toBe(true);
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
    expect(shippedSkills().map((s) => s.name)).toContain("sap-ui-automation");
  });

  test("Claude Code: project and --global, idempotent", () => {
    const first = installSkills({ targets: ["claude"], cwd, home, env: {} });
    const file = join(cwd, ".claude", "skills", "sap-ui-automation", "SKILL.md");
    expect(read(file)).toBe(read(join(packageRoot(), "skills", "sap-ui-automation", "SKILL.md")));
    expect(first.lines.find((l) => l.includes("sap-ui-automation"))).toContain(`created (${join(".claude", "skills", "sap-ui-automation")})`);
    expect(installSkills({ targets: ["claude"], cwd, home, env: {} }).lines.find((l) => l.includes("sap-ui-automation"))).toContain("unchanged");
    writeFileSync(file, "old");
    expect(installSkills({ targets: ["claude"], cwd, home, env: {} }).lines.find((l) => l.includes("sap-ui-automation"))).toContain("updated");
    installSkills({ targets: ["claude"], global: true, cwd, home, env: {} });
    expect(existsSync(join(home, ".claude", "skills", "sap-ui-automation", "SKILL.md"))).toBe(true);
  });

  test("Codex: .agents/skills in the project, ~/.agents/skills with --global", () => {
    installSkills({ targets: ["codex"], cwd, home, env: {} });
    expect(existsSync(join(cwd, ".agents", "skills", "sap-ui-automation", "SKILL.md"))).toBe(true);
    installSkills({ targets: ["codex"], global: true, cwd, home, env: {} });
    expect(existsSync(join(home, ".agents", "skills", "sap-ui-automation", "SKILL.md"))).toBe(true);
  });

  test("Cursor: a .mdc rule picked by description; no user-level rules", () => {
    installSkills({ targets: ["cursor"], cwd, home, env: {} });
    const rule = read(join(cwd, ".cursor", "rules", "sap-ui-automation.mdc"));
    expect(rule).toStartWith("---\ndescription: Works in SAP through");
    expect(rule).toContain("\nalwaysApply: false\n---\n");
    expect(rule).not.toContain("name: sap-ui-automation");
    expect(rule).toContain("# Driving SAP screens");
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
  test("readIfThere: undefined when there is no file, the content when there is, other errors thrown", () => {
    const file = join(cwd, "a.txt");
    expect(readIfThere(file)).toBeUndefined();
    writeFileSync(file, "hi");
    expect(readIfThere(file, "utf8")).toBe("hi");
    expect(readIfThere(file)?.equals(Buffer.from("hi"))).toBe(true);
    expect(() => readIfThere(cwd)).toThrow();
  });
});

describe("setup --extension", () => {
  test("a new entry gets SAP_BROWSER=extension; an existing one of ours is switched to the extension", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none, extension: true }, {}, "linux", home);
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers["sap-ui-automation"].env).toEqual({ SAP_BROWSER: "extension" });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "sap-ui-automation": { command: "x" } } }));
    const again = setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none, extension: true }, {}, "linux", home);
    expect(again.changed).toBe(1);
    expect(again.lines).toContain(`✓ Cursor: SAP_BROWSER=extension added to its entry in ${join("~", ".cursor", "mcp.json")}; skills up to date in ${join("~", ".agents", "skills")}.`);
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers["sap-ui-automation"]).toEqual({ command: "x", env: { SAP_BROWSER: "extension" } });
  });
  test("one command: the helper is installed too, and the Chrome steps follow", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    let calls = 0;
    const installHelper = () => (calls++, { hostDir: "/h", launcher: "/h/host.sh", registered: ["/chrome/x.json"] });
    const r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, installHelper }, {}, "linux", home);
    expect(calls).toBe(1);
    expect(r.lines).toContain("✓ Chrome extension helper: installed (1 browser profile folder(s)).");
    expect(r.lines.some((l) => l.includes("chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn") && l.includes("restart Chrome,"))).toBe(true);
    expect(r.lines.some((l) => l.includes("Chrome window it opens"))).toBe(false);
    // the order: agents, the helper, the restart step, then Chrome
    const at = (s: string) => r.lines.findIndex((l) => l.includes(s));
    expect(at("✓ Codex:")).toBeLessThan(at("Chrome extension helper"));
    expect(at("Chrome extension helper")).toBeLessThan(at("Next"));
    expect(at("Next")).toBeLessThan(at("Restart your agent apps"));
    expect(at("Restart your agent apps")).toBeLessThan(at("In Chrome:"));
    // the short summary says the same
    const short = setup({ dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, installHelper }, {}, "linux", home);
    expect(short.lines).toContain("✓ Chrome helper      installed");
    const none_ = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, installHelper: () => ({ hostDir: "/h", launcher: "/h/host.sh", registered: [] }) }, {}, "linux", home);
    expect(none_.lines.some((l) => l.startsWith("✗ Chrome extension helper:") && l.includes("extension pair"))).toBe(true);
    expect(none_.lines.some((l) => l.startsWith("✗ Chrome helper: copied to /h, but no browser profile folder took it"))).toBe(true);
    const failing = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, installHelper: () => { throw new Error("EACCES"); } }, {}, "linux", home);
    expect(failing.lines).toContain("✗ Chrome extension helper: EACCES. Pair by hand: npx -y sap-ui-automation extension pair.");
    expect(failing.lines).toContain("✗ Chrome helper: EACCES. Pair by hand: npx -y sap-ui-automation extension pair");
    const failingShort = setup({ dryRun: false, only: ["codex"], cwd, onPath: none, extension: true, installHelper: () => { throw new Error("EACCES"); } }, {}, "linux", home);
    expect(failingShort.lines).toContain("✗ Chrome helper      not installed");
    expect(failingShort.lines).toContain("Needs your attention");
    expect(failingShort.lines.some((l) => l.includes("restart Chrome"))).toBe(false);
    const dry = setup({ verbose: true, dryRun: true, only: ["codex"], cwd, onPath: none, extension: true, installHelper: () => { throw new Error("must not run"); } }, {}, "linux", home);
    expect(dry.lines).toContain("• Chrome extension helper: would install it, for the extension to pair in one click.");
    const plain = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, installHelper: () => { throw new Error("must not run"); } }, {}, "linux", home);
    expect(plain.lines.some((l) => l.includes("Chrome extension helper"))).toBe(false);
  });
  test("Codex's table carries the env", () => {
    expect(codexTable(["npx", "-y", "sap-ui-automation"], { SAP_BROWSER: "extension" })).toContain('env = { SAP_BROWSER = "extension" }');
  });
});

describe("setup: the skills too", () => {
  const skillsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const shared = () => join(home, ".agents", "skills");

  test("Codex and Cursor: one copy in ~/.agents/skills, marked as this package's, written once for both", () => {
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    const r = setup({ verbose: true, dryRun: false, only: ["codex", "cursor"], cwd, onPath: none }, {}, "linux", home);
    const dir = shared();
    expect(skillsIn(dir)).toEqual(["sap-ui-automation", "sap-ui-automation-cli"]);
    expect(existsSync(join(dir, "sap-ui-automation", ".sap-ui-automation"))).toBe(true);
    expect(read(join(dir, "sap-ui-automation", "SKILL.md"))).toBe(read(join(packageRoot(), "skills", "sap-ui-automation", "SKILL.md")));
    expect(r.lines).toContain(`✓ Codex: server added to ${join("~", ".codex", "config.toml")}; skills installed in ${join("~", ".agents", "skills")}.`);
    expect(r.lines).toContain(`✓ Cursor: server added to ${join("~", ".cursor", "mcp.json")}; skills installed in ${join("~", ".agents", "skills")}.`);
    expect(existsSync(join(home, ".cursor", "skills"))).toBe(false);
  });

  test("again: up to date; this package's changed copy is replaced; a folder of the same name that is not ours stays", () => {
    mkdirSync(join(home, ".codex"));
    const dir = shared();
    setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    const same = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(same.lines).toContain(`✓ Codex: server already in ${join("~", ".codex", "config.toml")}; skills up to date in ${join("~", ".agents", "skills")}.`);
    expect(same.lines.slice(-4)).toEqual(["", "Next", "  1. Ask your agent to look at your SAP screen. For Web GUI and Fiori, log on once in the Chrome window it opens.", "  2. Not working? npx -y sap-ui-automation doctor"]);
    writeFileSync(join(dir, "sap-ui-automation", "SKILL.md"), "old copy");
    rmSync(join(dir, "sap-ui-automation-cli"), { recursive: true });
    mkdirSync(join(dir, "sap-ui-automation-cli"));
    writeFileSync(join(dir, "sap-ui-automation-cli", "SKILL.md"), "---\nname: sap-ui-automation-cli\n---\nmine");
    const r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(read(join(dir, "sap-ui-automation", "SKILL.md"))).toBe(read(join(packageRoot(), "skills", "sap-ui-automation", "SKILL.md")));
    expect(read(join(dir, "sap-ui-automation-cli", "SKILL.md"))).toBe("---\nname: sap-ui-automation-cli\n---\nmine");
    const sk = join("~", ".agents", "skills");
    expect(r.lines).toContain(`✓ Codex: server already in ${join("~", ".codex", "config.toml")}; skill sap-ui-automation updated in ${sk}; skill sap-ui-automation-cli in ${sk} not from this package, left as it is.`);
  });

  test("setup preserves edits and extra files in unmarked copies from install --skills --global", () => {
    mkdirSync(join(home, ".codex"));
    installSkills({ targets: ["codex"], global: true, cwd, home, env: {} });
    const dir = shared();
    const main = join(dir, "sap-ui-automation", "SKILL.md");
    const edited = read(main) + "\nmy local instructions";
    writeFileSync(main, edited);
    const extra = join(dir, "sap-ui-automation-cli", "notes.md");
    writeFileSync(extra, "local notes");
    const r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(read(main)).toBe(edited);
    expect(read(extra)).toBe("local notes");
    expect(r.lines.join("\n")).toContain("left as they are");
    for (const name of ["sap-ui-automation", "sap-ui-automation-cli"])
      expect(existsSync(join(dir, name, ".sap-ui-automation"))).toBe(false);
  });

  test("copies under the old names (sap-gui-drive, sap-gui-cli) that this package wrote are removed; someone else's stay", () => {
    mkdirSync(join(home, ".codex"));
    const dir = shared();
    mkdirSync(join(dir, "sap-gui-drive"), { recursive: true });
    writeFileSync(join(dir, "sap-gui-drive", "SKILL.md"), "---\nname: sap-gui-drive\n---\nold");
    writeFileSync(join(dir, "sap-gui-drive", ".sap-ui-automation"), "");
    mkdirSync(join(dir, "sap-gui-cli"));
    writeFileSync(join(dir, "sap-gui-cli", "SKILL.md"), "---\nname: sap-gui-cli\n---\nmine");
    const dry = setup({ verbose: true, dryRun: true, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(dry.lines).toContain(`  Would remove the skills' old names sap-gui-drive in ${join("~", ".agents", "skills")}.`);
    expect(existsSync(join(dir, "sap-gui-drive"))).toBe(true);
    const r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(r.lines).toContain(`  Removed the skills' old names sap-gui-drive in ${join("~", ".agents", "skills")}.`);
    expect(skillsIn(dir)).toEqual(["sap-gui-cli", "sap-ui-automation", "sap-ui-automation-cli"]);
  });

  test("install removes a marked old skill and preserves custom old-named skills and Cursor rules", () => {
    const old = join(cwd, ".claude", "skills", "sap-gui-drive");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "SKILL.md"), "---\nname: sap-gui-drive\n---\nUses the sap-ui-automation tools.");
    writeFileSync(join(old, ".sap-ui-automation"), "");
    const custom = join(cwd, ".claude", "skills", "sap-gui-cli");
    mkdirSync(custom);
    writeFileSync(join(custom, "SKILL.md"), "---\nname: sap-gui-cli\n---\nUses sap-ui-automation.");
    writeFileSync(join(custom, "notes"), "local notes");
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "rules", "sap-gui-cli.mdc"), "---\ndescription: x\n---\nsap-ui-automation CLI");
    const kept = installSkills({ targets: ["claude", "cursor"], cwd, home, env: {}, overwrite: false });
    expect(kept.lines.some((l) => l.startsWith("– Claude Code skill sap-gui-drive: the old name of sap-ui-automation, kept"))).toBe(true);
    expect(existsSync(old)).toBe(true);
    const r = installSkills({ targets: ["claude", "cursor"], cwd, home, env: {} });
    expect(r.lines.some((l) => l.startsWith("• Claude Code skill sap-gui-drive: removed, now sap-ui-automation"))).toBe(true);
    expect(read(join(custom, "notes"))).toBe("local notes");
    expect(existsSync(old)).toBe(false);
    expect(read(join(cwd, ".cursor", "rules", "sap-gui-cli.mdc"))).toBe("---\ndescription: x\n---\nsap-ui-automation CLI");
  });

  test("--no-skills, a dry run, and apps that read no skills write none", () => {
    mkdirSync(join(home, ".codex"));
    setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    rmSync(join(home, ".codex", "config.toml"));
    const dry = setup({ verbose: true, dryRun: true, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(dry.lines).toContain(`• Codex: would add the server to ${join("~", ".codex", "config.toml")}; skills would be installed in ${join("~", ".agents", "skills")}.`);
    const desktop = setup({ verbose: true, dryRun: false, only: ["claude-desktop"], cwd, onPath: none }, { APPDATA: join(home, "AppData") }, "win32", home);
    expect(desktop.lines.some((l) => l.startsWith("✓ Claude Desktop:") && l.includes("it reads no skills from disk"))).toBe(true);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("--no-mcp: the skills only, for agents that would refuse the server too", () => {
    mkdirSync(join(home, ".cursor"));
    const r = setup({ verbose: true, dryRun: false, only: ["cursor", "roo"], cwd, onPath: none, mcp: false }, {}, "linux", home);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(r.lines.some((l) => l.startsWith("Command for MCP clients"))).toBe(false);
    expect(r.lines).toContain(`✓ Cursor: skills installed in ${join("~", ".agents", "skills")}.`);
    expect(r.lines).toContain(`✓ Roo Code: skills linked in ${join("~", ".roo", "skills")} → ${join("~", ".agents", "skills")}.`);
  });
});

describe("setup: Cursor, Windsurf, VS Code", () => {
  test("Cursor: the user's mcp.json, or the project's when it has one; never twice", () => {
    mkdirSync(join(home, ".cursor"));
    expect(detectClients({ cwd, onPath: none }, {}, "linux", home)).toEqual(["cursor"]);
    const r = setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    expect(r.changed).toBe(1);
    expect(Object.keys(json(join(home, ".cursor", "mcp.json")).mcpServers)).toEqual(["sap-ui-automation"]);
    expect(setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.includes("already in"))).toBe(true);

    mkdirSync(join(cwd, ".cursor"));
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    const project = json(join(cwd, ".cursor", "mcp.json"));
    expect(Object.keys(project.mcpServers)).toEqual(["other", "sap-ui-automation"]);
    expect(existsSync(join(cwd, ".cursor", "mcp.json.bak"))).toBe(true);
  });

  test("nothing found: nothing written, and how to name an agent", () => {
    const r = setup({ verbose: true, dryRun: false, cwd, onPath: none }, {}, "linux", home);
    expect(r.lines.some((l) => l.startsWith("No agent found. Name one:"))).toBe(true);
    expect(r.lines).toContain("Skills for other agents: npx skills add DidroAI/sap-ui-mcp");
    expect(readdirSync(home)).toEqual([]);
    mkdirSync(join(home, ".cursor"));
    const dry = setup({ verbose: true, dryRun: true, cwd, onPath: none }, {}, "linux", home);
    expect(dry.lines.some((l) => l.startsWith("• Cursor: would add the server"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("a broken mcp.json is reported, not overwritten, and gets no skills", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{oops");
    const r = setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
    expect(r.lines.some((l) => l.startsWith("✗ Cursor:") && l.includes("not valid JSON"))).toBe(true);
    expect(read(join(home, ".cursor", "mcp.json"))).toBe("{oops");
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("a config that is not an object, or whose mcpServers is not one, is left alone", () => {
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    for (const text of ["null", "[]", '"x"', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      writeFileSync(file, text);
      const r = setup({ verbose: true, dryRun: false, only: ["cursor"], cwd, onPath: none }, {}, "linux", home);
      expect(r.changed).toBe(0);
      expect(r.lines.some((l) => l.startsWith("✗ Cursor:") && l.includes("by hand") && l.includes('"sap-ui-automation"'))).toBe(true);
      expect(read(file)).toBe(text);
    }
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  test("the first .bak is kept, and no temporary file is left behind", () => {
    mkdirSync(join(cwd, ".vscode"));
    const file = join(cwd, ".vscode", "mcp.json");
    writeFileSync(file, '{"servers": {}}');
    setup({ verbose: true, dryRun: false, only: ["vscode"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(`${file}.bak`)).toBe('{"servers": {}}');
    // the user removes our entry; a second run must not replace the original backup
    writeFileSync(file, '{"servers": {"mine": {}}}');
    setup({ verbose: true, dryRun: false, only: ["vscode"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(read(`${file}.bak`)).toBe('{"servers": {}}');
    expect(Object.keys(json(file).servers)).toEqual(["mine", "sap-ui-automation"]);
    expect(readdirSync(join(cwd, ".vscode")).sort()).toEqual(["mcp.json", "mcp.json.bak"]);
  });

  test("Codex: a quoted or sub-table entry is found; an unclear mention is refused with the table to add", () => {
    const file = join(home, ".codex", "config.toml");
    const shown = join("~", ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    writeFileSync(file, '[mcp_servers."sap-ui-automation".env]\nA = "1"\n');
    let r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none, skills: false }, {}, "linux", home);
    expect(r.lines).toContain(`✓ Codex: server already in ${shown}.`);
    expect(read(file)).toBe('[mcp_servers."sap-ui-automation".env]\nA = "1"\n');
    writeFileSync(file, '[mcp_servers.sap]\nargs = ["sap-ui-automation"]\n');
    r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(r.changed).toBe(0);
    expect(r.lines.some((l) => l.startsWith("✗ Codex:"))).toBe(true);
    expect(r.lines).toContain("    [mcp_servers.sap-ui-automation]");
    expect(read(file)).toBe('[mcp_servers.sap]\nargs = ["sap-ui-automation"]\n');
    expect(existsSync(join(home, ".agents"))).toBe(false);
    writeFileSync(file, 'model = "x"\n');
    r = setup({ verbose: true, dryRun: false, only: ["codex"], cwd, onPath: none }, {}, "linux", home);
    expect(r.changed).toBe(1);
    expect(read(file)).toStartWith('model = "x"\n\n[mcp_servers.sap-ui-automation]\n');
  });

  test("Windsurf (Devin Desktop): writes ~/.config/devin/mcp_config.json, found by the old folder too", async () => {
    const file = join(home, ".config", "devin", "mcp_config.json");
    expect(detectClients({ cwd, onPath: none }, {}, "linux", home)).toEqual([]);
    // An older Windsurf: its folder says it is installed; the server goes to the file it reads now.
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    expect(detectClients({ cwd, onPath: none }, {}, "linux", home)).toEqual(["windsurf"]);
    expect(setup({ verbose: true, dryRun: true, cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.startsWith("• Windsurf (Devin Desktop): would add the server"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    const r = await init({ ...base(), yes: true });
    expect(r.lines.some((l) => l.startsWith(`✓ Windsurf (Devin Desktop): server added to ${join("~", ".config", "devin", "mcp_config.json")}`))).toBe(true);
    expect(json(file).mcpServers["sap-ui-automation"].args).toBeArray();
    expect(existsSync(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(false);
  });

  test("Windsurf (Devin Desktop): XDG_CONFIG_HOME and %APPDATA%", () => {
    mkdirSync(join(home, "xdg", "devin"), { recursive: true });
    setup({ verbose: true, dryRun: false, cwd, onPath: none, only: ["windsurf"] }, { XDG_CONFIG_HOME: join(home, "xdg") }, "linux", home);
    expect(json(join(home, "xdg", "devin", "mcp_config.json")).mcpServers["sap-ui-automation"]).toBeDefined();
    setup({ verbose: true, dryRun: false, cwd, onPath: none, only: ["windsurf"] }, { APPDATA: join(home, "AppData") }, "win32", home);
    expect(json(join(home, "AppData", "devin", "mcp_config.json")).mcpServers["sap-ui-automation"]).toBeDefined();
  });

  test("VS Code: only a project that has .vscode/mcp.json, under `servers`; its comments are kept", () => {
    expect(setup({ verbose: true, dryRun: false, cwd, onPath: none }, {}, "linux", home).lines.some((l) => l.includes("VS Code"))).toBe(false);
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), '{\n  // mine\n  "servers": {},\n}\n');
    setup({ verbose: true, dryRun: false, cwd, onPath: none }, {}, "linux", home);
    const text = read(join(cwd, ".vscode", "mcp.json"));
    expect(text).toContain("// mine");
    expect(text).toContain('"type": "stdio"');
    expect(existsSync(join(home, ".copilot", "skills", "sap-ui-automation", "SKILL.md"))).toBe(true);
  });
});
