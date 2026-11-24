import { describe, expect, test } from "bun:test";
import { doctorReport } from "../src/cli/doctor.js";
import { codexTable, launchCommand } from "../src/cli/setup.js";
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
  test("all good says Ready", async () => {
    const r = await doctorReport([surface("webgui", [{ ok: true, check: "Chrome", detail: "attached" }])], "0.0.0", "linux", 100);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Ready.");
  });
});
