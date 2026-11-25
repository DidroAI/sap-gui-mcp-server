import { describe, expect, test } from "bun:test";
import { surfacesFromEnv } from "../src/surfaces.js";

describe("SAP_SURFACES and SAP_GUI_METHOD (review, 2026-11-24)", () => {
  test("any case, spaces and empty entries are ignored, each surface once", () => {
    expect(surfacesFromEnv({ SAP_SURFACES: " WebGUI, fiori,,webgui " }).map((s) => s.name)).toEqual(["webgui", "fiori"]);
    expect(surfacesFromEnv({ SAP_SURFACES: " " }).map((s) => s.name)).toEqual(surfacesFromEnv({}).map((s) => s.name));
  });
  test("an unknown surface or method is an error", () => {
    expect(() => surfacesFromEnv({ SAP_SURFACES: "webgui,gui" })).toThrow('Unknown surface "gui"');
    expect(() => surfacesFromEnv({ SAP_SURFACES: "webgui", SAP_GUI_METHOD: "dial" })).toThrow("SAP_GUI_METHOD must be auto, scripting or diag");
    expect(surfacesFromEnv({ SAP_SURFACES: "webgui", SAP_GUI_METHOD: "DIAG" }).map((s) => s.name)).toEqual(["webgui"]);
  });
});

describe("SAP GUI for Windows: the agent works with the method that sees its session", () => {
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const methods = (env: Record<string, string>) => {
    const all = surfacesFromEnv({ SAP_SURFACES: "sapgui", SAP_DIAG_PORT: port, ...env }, "win32");
    for (const s of all) void s.close?.();
    return all.map((s) => s.method ?? "scripting");
  };
  test("unset (auto): scripting and the DIAG reader both run", () => {
    expect(methods({})).toEqual(["scripting", "diag"]);
    expect(methods({ SAP_GUI_METHOD: " Auto " })).toEqual(["scripting", "diag"]);
  });
  test("SAP_GUI_METHOD pins one, for setups where nobody watches the agent", () => {
    expect(methods({ SAP_GUI_METHOD: "scripting" })).toEqual(["scripting"]);
    expect(methods({ SAP_GUI_METHOD: "diag" })).toEqual(["diag"]);
  });
  test("not on Windows: no SAP GUI surface unless named", () => {
    expect(surfacesFromEnv({}, "darwin").map((s) => s.name)).toEqual(["webgui", "fiori"]);
  });
});
