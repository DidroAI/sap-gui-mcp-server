import { describe, expect, test } from "bun:test";
import { actionText, normalizeAction, normalizeKey, VERBS } from "../src/core/action.js";
import { ActionError } from "../src/core/types.js";

describe("normalizeAction", () => {
  test("a key given as value becomes key: assess and act read the same thing", () => {
    expect(normalizeAction({ do: "key", value: 11 })).toEqual({ do: "key", key: 11 });
    expect(normalizeAction({ do: "key", value: "11" })).toEqual({ do: "key", key: 11 });
    expect(normalizeAction({ do: "key", key: 0, value: 11 })).toEqual({ do: "key", key: 0 });
    expect(normalizeAction({ do: "key", key: " 8 " })).toEqual({ do: "key", key: 8 });
  });
  test("key names come out in one spelling", () => {
    expect(normalizeKey("enter")).toBe("Enter");
    expect(normalizeKey("RETURN")).toBe("Enter");
    expect(normalizeKey("ctrl+S")).toBe("Control+s");
    expect(normalizeKey("shift + tab")).toBe("Shift+Tab");
    expect(normalizeKey("Shift+Control+f1")).toBe("Control+Shift+F1");
    expect(normalizeKey("pagedown")).toBe("PageDown");
    expect(normalizeKey("Back")).toBe("Back");
    expect(normalizeKey("f24")).toBe("F24");
  });
  test("anything else as a key is refused", () => {
    for (const bad of [undefined, null, NaN, 1.5, -1, 100, "100", "", "save", "F25", "s", "Shift+s", "Hyper+Enter", true, "Enter+Enter+"])
      expect(() => normalizeAction({ do: "key", key: bad })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "key", key: { n: 11 } })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "key" })).toThrow(ActionError);
  });
  test("do is trimmed, lower-cased, and must be known", () => {
    expect(normalizeAction({ do: " Press ", id: "btn[8]" })).toEqual({ do: "press", id: "btn[8]" });
    expect(normalizeAction({ do: "fill", id: "x", value: "1" }).do).toBe("set");
    expect(normalizeAction({ do: "double", id: "x" }).do).toBe("dblclick");
    for (const bad of ["", "save", "press\nokcode", "eval", 3, undefined]) expect(() => normalizeAction({ do: bad, id: "x" })).toThrow(ActionError);
    expect(() => normalizeAction(null)).toThrow(ActionError);
    expect(() => normalizeAction("press")).toThrow(ActionError);
    expect(VERBS).toContain("okcode");
  });
  test("line breaks leave string values and ids", () => {
    expect(normalizeAction({ do: "set", id: "ctxtA\r\n", value: "OR\n/nSE38\r" })).toEqual({ do: "set", id: "ctxtA", value: "OR/nSE38" });
    expect(normalizeAction({ do: "okcode", value: " /nVA03\n" })).toEqual({ do: "okcode", value: "/nVA03" });
    expect(normalizeAction({ do: "tree", id: "shell", node: "  4\n", how: "double" })).toEqual({ do: "tree", id: "shell", node: "  4", how: "double" });
    expect(normalizeAction({ do: "combo", id: "c", key: "PR\nOG" })).toEqual({ do: "combo", id: "c", key: "PROG" });
  });
  test("values are scalars; ids are strings", () => {
    expect(() => normalizeAction({ do: "set", id: "x", value: ["a\n"] })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "set", id: "x", value: { toString: "x" } })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "press", id: 5 })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "grid", id: "g", row: 1.5, col: "A" })).toThrow(ActionError);
    expect(normalizeAction({ do: "check", id: "x", value: true })).toEqual({ do: "check", id: "x", value: true });
    expect(normalizeAction({ do: "grid", id: "g", row: 0, col: 3 })).toEqual({ do: "grid", id: "g", row: 0, col: "3" });
  });
  test("okcode needs a string", () => {
    for (const bad of [undefined, 11, "", "  ", true]) expect(() => normalizeAction({ do: "okcode", value: bad })).toThrow(ActionError);
  });
  test("the result cannot be changed afterwards", () => {
    const a = normalizeAction({ do: "key", key: 0 });
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as { key: unknown }).key = 11;
    }).toThrow();
  });
  test("scroll: a row counted from 0, or a direction in one spelling", () => {
    expect(normalizeAction({ do: "scroll", id: "g", to: 120 })).toEqual({ do: "scroll", id: "g", to: 120 });
    expect(normalizeAction({ do: "scroll", id: "g", to: " 120 " })).toEqual({ do: "scroll", id: "g", to: 120 });
    expect(normalizeAction({ do: "scroll", id: "g", to: "Next" })).toEqual({ do: "scroll", id: "g", to: "next" });
    // Fiori's words for the same.
    expect(normalizeAction({ do: "scroll", to: "down" })).toEqual({ do: "scroll", to: "next" });
    expect(normalizeAction({ do: "scroll", to: "bottom" })).toEqual({ do: "scroll", to: "last" });
    expect(normalizeAction({ do: "scroll", how: "down" })).toEqual({ do: "scroll", how: "down" });
    for (const bad of [-1, 1.5, "sideways", true]) expect(() => normalizeAction({ do: "scroll", id: "g", to: bad })).toThrow('scroll "to" is a row number');
  });
  test("actionText does not depend on property order", () => {
    expect(actionText(normalizeAction({ do: "set", value: "1", id: "x" }))).toBe(actionText(normalizeAction({ id: "x", do: "set", value: "1" })));
  });
});
