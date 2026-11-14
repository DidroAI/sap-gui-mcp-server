import { describe, expect, test } from "bun:test";
import { compact } from "../../src/core/compact.js";
import { controlLines, esc, fullView } from "../../src/sapgui/format.js";
import { expected, NAMES, screen } from "./fixtures.js";

describe("sapgui full view", () => {
  // expected/*.txt is what the Python bridge prints for the same screens (fixtures/make.py).
  for (const name of NAMES)
    test(`${name}: same text as the Python bridge`, () => {
      expect(fullView(screen(name))).toBe(expected(name));
    });

  test("a password field never shows its content", () => {
    const view = fullView(screen("va01"));
    expect(view).toContain('pwdDEMO-SECRET  field  Secret = ""  (edit)');
    expect(JSON.stringify(screen("va01"))).not.toContain("****");
  });

  test("a grid shows 50 rows and says how many more there are", () => {
    const view = fullView(screen("va05"));
    expect(view).toContain("grid  52 rows; columns: VBELN=Sales Doc. | AUDAT=Doc. Date | NETWR=Net value");
    expect(view).toContain("  row 49: 4749 | 01.02.2005 | 5000.00");
    expect(view).toContain("  ... 2 more rows");
  });

  test("a tree shows what the user sees: nodes under a closed folder are left out", () => {
    const view = fullView(screen("va03-texts"));
    expect(view).toContain("  [-] Header texts  {node 1}\n    Form Header  {node 2}");
    expect(view).toContain("  [+] Other  {node 4}");
    expect(view).not.toContain("Hidden under a closed folder");
  });

  test("a shell that could not be read says so", () => {
    expect(controlLines({ id: "wnd[0]/usr/shell", type: "GuiShell", name: "shell", sub: "Tree", error: "no\naccess" })).toEqual(["wnd[0]/usr/shell  shell error no access"]);
  });

  test("texts become one line", () => {
    expect(esc("  a\nb \r\n")).toBe("a b");
    expect(esc(undefined)).toBe("");
  });

  test("the compact view keeps the content and shortens ids and table rows", () => {
    const view = compact(fullView(screen("va03")));
    expect(view).toContain('txtVBAK-VBELN  field  Standard Order = "4711"  (read-only)');
    expect(view).toContain("row 1: Item=20; Material=M-02; Order Quantity=1; Rej [x]");
    expect(view.length).toBeLessThan(fullView(screen("va03")).length / 2);
  });
});
