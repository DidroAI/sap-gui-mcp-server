/**
 * The keyboard host (ps/input-lib.ps1) runs on Windows only. These checks read
 * its source for two faults seen against live SAP GUI, so that they do not
 * come back unnoticed; the behaviour itself was checked on a live system.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lib = readFileSync(join(import.meta.dir, "../../src/sapgui-diag/ps/input-lib.ps1"), "utf8");

describe("keyboard host", () => {
  test("navigation keys go as extended keys: Shift+End must select, or set types after the old value", () => {
    expect(lib).toMatch(/static bool Extended\(byte vk\) \{ return \(vk >= 0x21 && vk <= 0x28\) \|\| vk == 0x2D \|\| vk == 0x2E; \}/);
    expect(lib).toMatch(/keybd_event\(vk, scan, ext, UIntPtr\.Zero\); keybd_event\(vk, scan, ext \| 2u, UIntPtr\.Zero\);/);
  });

  test("the command field has the keyboard focus before its Enter (a tree or grid may keep it)", () => {
    const okcode = lib.slice(lib.indexOf("if ($do -eq 'okcode')"), lib.indexOf("elseif ($do -eq 'key')"));
    expect(okcode).toContain("[SapScreen]::GiveFocus($edit)");
    expect(okcode.indexOf("[SapScreen]::Focus($top) -ne $edit) { throw")).toBeLessThan(okcode.indexOf("[SapScreen]::Key(0x0D"));
  });
});
