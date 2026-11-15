/**
 * Every PowerShell script of the package must parse in Windows PowerShell 5.1:
 * the unit tests drive a fake host, so a syntax error in the real one (such as
 * "$row:" read as a scoped variable) would otherwise only show on a user's
 * machine. Runs where powershell.exe exists (the Windows CI runner).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = ["src/sapgui/ps", "src/sapgui-diag/ps"];
const scripts = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ps1")).map((f) => join(d, f)));
const onWindows = process.platform === "win32";

describe("PowerShell scripts parse", () => {
  test.skipIf(!onWindows).each(scripts)("%s", (file) => {
    const ps = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '${file}'), [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  });

  test("the list of scripts is not empty", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });
});
