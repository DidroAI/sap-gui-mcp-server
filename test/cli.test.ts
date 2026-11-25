import { describe, expect, test } from "bun:test";
import { doctorReport } from "../src/cli/doctor.js";
import { cmdArg, cmdLine, codexHas, codexTable, launchCommand } from "../src/cli/setup.js";
import type { Surface } from "../src/core/types.js";

const surface = (name: "webgui" | "fiori" | "sapgui", checks: Awaited<ReturnType<Surface["doctor"]>>): Surface => ({
  name,
  discover: async () => [],
  open: async () => {
    throw new Error("no");
  },
  doctor: async () => checks,
});

describe("setup", () => {
  test("the command follows how the server is installed", () => {
    expect(launchCommand("/home/u/.npm/_npx/abc/node_modules/sap-ui-automation/dist/cli.js", "darwin", false, "/usr/bin/node")).toEqual(["npx", "-y", "sap-ui-automation"]);
    expect(launchCommand("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\x\\cli.js", "win32", false, "node.exe")).toEqual(["cmd", "/c", "npx", "-y", "sap-ui-automation"]);
    expect(launchCommand("/usr/local/lib/node_modules/sap-ui-automation/dist/cli.js", "darwin", true, "/usr/bin/node")).toEqual(["sap-ui-automation"]);
    expect(launchCommand("/repo/dist/cli.js", "linux", false, "/usr/bin/node")).toEqual(["/usr/bin/node", "/repo/dist/cli.js"]);
  });
  test("Codex gets a TOML table", () => {
    expect(codexTable(["npx", "-y", "sap-ui-automation"])).toBe('\n[mcp_servers.sap-ui-automation]\ncommand = "npx"\nargs = ["-y", "sap-ui-automation"]\n');
  });
  test("Codex: every form of an existing entry is found; an unknown mention is not guessed", () => {
    expect(codexHas("")).toBe("no");
    expect(codexHas('[mcp_servers.other]\ncommand = "x"\n')).toBe("no");
    expect(codexHas("[mcp_servers.sap-ui-automation]\ncommand = 'x'")).toBe("yes");
    expect(codexHas('[mcp_servers."sap-ui-automation"]\n')).toBe("yes");
    expect(codexHas("[mcp_servers.'sap-ui-automation']\n")).toBe("yes");
    expect(codexHas("  [ mcp_servers . sap-ui-automation ]\n")).toBe("yes");
    expect(codexHas("[mcp_servers.sap-ui-automation.env]\nA = '1'\n")).toBe("yes");
    expect(codexHas('mcp_servers.sap-ui-automation = { command = "x" }\n')).toBe("yes");
    expect(codexHas('[mcp_servers]\nsap-ui-automation = { command = "x" }\n')).toBe("yes");
    expect(codexHas('mcp_servers = { "sap-ui-automation" = { command = "x" } }\n')).toBe("yes");
    expect(codexHas('[mcp_servers.sap]\nargs = ["-y", "sap-ui-automation"]\n')).toBe("unsure");
  });
  test("Windows: arguments are quoted for cmd, so spaces and & stay inside one argument", () => {
    expect(cmdArg("mcp", false)).toBe('^"mcp^"');
    expect(cmdArg("C:\\Program Files\\nodejs\\node.exe", false)).toBe('^"C:\\Program^ Files\\nodejs\\node.exe^"');
    expect(cmdArg("a&b", false)).toBe('^"a^&b^"');
    // a quote is escaped for the program, the backslashes before it doubled
    expect(cmdArg('say "hi"\\', false)).toBe('^"say^ \\^"hi\\^"\\\\^"');
    // a .cmd shim reads its %* once more: escaped twice
    expect(cmdArg("a&b", true)).toBe('^^^"a^^^&b^^^"');
    expect(cmdLine("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", ["mcp", "add", "--", "C:\\Program Files\\nodejs\\node.exe"])).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd ^^^"mcp^^^" ^^^"add^^^" ^^^"--^^^" ^^^"C:\\Program^^^ Files\\nodejs\\node.exe^^^"',
    );
  });
});

describe("doctor report", () => {
  test("Chrome's checks appear once for Web GUI and Fiori, with the fix", async () => {
    const chrome = { ok: false, check: "Chrome", detail: "no Chrome with remote debugging allowed is running", fix: "open chrome://inspect" };
    const r = await doctorReport([surface("webgui", [chrome]), surface("fiori", [chrome])], "0.0.0", "darwin", 100);
    expect(r.ok).toBe(false);
    expect(r.text.match(/✗ Chrome:/g)?.length).toBe(1);
    expect(r.text).toContain("→ open chrome://inspect");
    expect(r.text).toContain("SAP GUI for Windows");
    expect(r.text).toContain("Not ready yet");
  });
  test("SAP GUI read both ways: one that works is enough, either one", async () => {
    const sapgui = (ok: boolean, method?: string) => ({ ...surface("sapgui", [{ ok, check: method ?? "scripting", detail: ok ? "on" : "off" }]), ...(method ? { method } : {}) });
    const scriptingOnly = await doctorReport([sapgui(true), sapgui(false, "diag")], "0.0.0", "win32", 100);
    expect(scriptingOnly.ok).toBe(true);
    expect(scriptingOnly.text).toContain("SAP GUI for Windows: network reader (DIAG)");
    expect(scriptingOnly.text).toContain("Either way of reading SAP GUI is enough");
    expect((await doctorReport([sapgui(false), sapgui(true, "diag")], "0.0.0", "win32", 100)).ok).toBe(true);
    expect((await doctorReport([sapgui(false), sapgui(false, "diag")], "0.0.0", "win32", 100)).ok).toBe(false);
    expect((await doctorReport([sapgui(false)], "0.0.0", "win32", 100)).ok).toBe(false);
  });
  test("all good says Ready", async () => {
    const r = await doctorReport([surface("webgui", [{ ok: true, check: "Chrome", detail: "attached" }])], "0.0.0", "linux", 100);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Ready.");
  });
});

describe("setup finds entries left from before the rename", () => {
  test("in JSON configs and in Codex's config.toml", async () => {
    const { oldJsonEntries, oldCodexEntries } = await import("../src/cli/setup.js");
    expect(oldJsonEntries(JSON.stringify({ mcpServers: { "sap-gui-mcp-server": {}, "sap-ui-automation": {} } }), "mcpServers")).toEqual(["sap-gui-mcp-server"]);
    expect(oldJsonEntries(JSON.stringify({ servers: { "sap-gui": {} } }), "servers")).toEqual(["sap-gui"]);
    expect(oldJsonEntries("not json", "mcpServers")).toEqual([]);
    expect(oldCodexEntries('[mcp_servers.sap-ui-automation]\n\n[mcp_servers."sap-gui-mcp-server"]\ncommand = "node"\n')).toEqual(["sap-gui-mcp-server"]);
    expect(oldCodexEntries("[mcp_servers.sap-gui]\n")).toEqual(["sap-gui"]);
    expect(oldCodexEntries("[mcp_servers.sap-ui-automation]\n")).toEqual([]);
  });
});
