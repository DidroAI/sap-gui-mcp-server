import { describe, expect, test } from "bun:test";
import { surfacesFromEnv } from "../src/surfaces.js";

describe("SAP_SURFACES and SAP_GUI_METHOD (review, 2026-11-24)", () => {
  test("any case, spaces and empty entries are ignored, each surface once", () => {
    expect(surfacesFromEnv({ SAP_SURFACES: " WebGUI, fiori,,webgui " }).map((s) => s.name)).toEqual(["webgui", "fiori"]);
    expect(surfacesFromEnv({ SAP_SURFACES: " " }).map((s) => s.name)).toEqual(surfacesFromEnv({}).map((s) => s.name));
  });
  test("an unknown surface or method is an error", () => {
    expect(() => surfacesFromEnv({ SAP_SURFACES: "webgui,gui" })).toThrow('Unknown surface "gui"');
    expect(() => surfacesFromEnv({ SAP_SURFACES: "webgui", SAP_GUI_METHOD: "dial" })).toThrow("SAP_GUI_METHOD must be scripting or diag");
    expect(surfacesFromEnv({ SAP_SURFACES: "webgui", SAP_GUI_METHOD: "DIAG" }).map((s) => s.name)).toEqual(["webgui"]);
  });
});
