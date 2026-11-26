/**
 * On a screen that only displays (its title says so and it offers no Save), a toolbar button or a button of the
 * body that does not say it acts moves to another view: the rule of the scripting surface (sapgui/assess.ts
 * displayButton). Round 1 on S/4 (MD-03): BP's "Company Code" in "Display Organization" was refused as a write
 * with writes off. A commit word, an act word, or a screen that offers Save keeps it a write.
 */
import { describe, expect, test } from "bun:test";
import type { DiagKey, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, resolveTarget } from "../../src/sapgui-diag/index.js";

const key = (vkey: number, k: string, text: string, enabled = true): DiagKey => ({ vkey, key: k, text, tooltip: "", icon: "", enabled });
const screen = (title: string, keys: DiagKey[]): DiagScreen =>
  ({ mode: 0, step: 1, session: { language: "E", tcode: "BP" }, windows: [{ index: 0, modal: false, title, program: "SAPLBUS_LOCATOR", dynpro: "3000", guiStatus: "", guiStatusProgram: "", size: { rows: 17, cols: 124 }, menus: [], toolbar: keys, keys: [], elements: [], tabstrips: [], tables: [], controls: [], containers: [] } as unknown as DiagWindow] }) as DiagScreen;
const assess = (s: DiagScreen, id: string) => assessDiag(s, { do: "press", id }, resolveTarget(s, { do: "press", id }));

describe("a button on a screen that only displays", () => {
  test("navigates", () => {
    const s = screen("Display Organization: 17300031", [key(26, "Ctrl+F2", "Company Code"), key(11, "Ctrl+S", "Save", false)]);
    expect(assess(s, "Company Code")).toMatchObject({ risk: "navigate", reason: expect.stringContaining("only displays") });
  });
  test("a change screen, an offered Save, or a word that acts keep it a write", () => {
    expect(assess(screen("Change Organization: 17300031", [key(26, "Ctrl+F2", "Company Code")]), "Company Code").risk).toBe("commit");
    expect(assess(screen("Display Organization: 17300031", [key(26, "Ctrl+F2", "Company Code"), key(11, "Ctrl+S", "Save")]), "Company Code").risk).toBe("commit");
    expect(assess(screen("Display Organization: 17300031", [key(26, "Ctrl+F2", "Execute")]), "Execute").risk).toBe("commit");
    // No keys read: nothing proves the screen offers no Save.
    const bare = screen("Display Organization: 17300031", []);
    (bare.windows[0] as DiagWindow).elements = [{ kind: "button", name: "", text: "Company Code", fcode: "ZCC", row: 1, col: 1, width: 12, input: true, hidden: false, path: [], etype: 115 } as never];
    expect(assess(bare, "{ZCC}").risk).toBe("commit");
  });
});
