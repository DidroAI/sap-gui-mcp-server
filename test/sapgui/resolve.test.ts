import { describe, expect, test } from "bun:test";
import { relativeId, resolve, resolveStrict } from "../../src/sapgui/resolve.js";
import type { Screen } from "../../src/sapgui/facts.js";
import { screen } from "./fixtures.js";

const TAB = "wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01/ssubSUBSCREEN_BODY:SAPMV45A:4400";

describe("sapgui ids", () => {
  test("a full id", () => {
    expect(resolve(screen("va01"), "wnd[0]/usr/ctxtVBAK-AUART")?.id).toBe("wnd[0]/usr/ctxtVBAK-AUART");
  });
  test("an id with its session in front", () => {
    expect(relativeId("/app/con[0]/ses[1]/wnd[0]/usr/ctxtX")).toBe("wnd[0]/usr/ctxtX");
    expect(resolve(screen("va01"), "/app/con[0]/ses[0]/wnd[0]/usr/ctxtVBAK-AUART")?.id).toBe("wnd[0]/usr/ctxtVBAK-AUART");
  });
  test("a full id with a wrong path falls back to its last segment", () => {
    expect(resolve(screen("va03"), "wnd[0]/usr/tabsGUESSED/tabpT\\02")?.id).toBe("wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\02");
  });
  test("a short id from the compact view", () => {
    expect(resolve(screen("va03"), "chkVBAK-AUTLF")?.id).toBe(`${TAB}/chkVBAK-AUTLF`);
    expect(resolve(screen("va01"), "tbar[1]/btn[8]")?.id).toBe("wnd[0]/tbar[1]/btn[8]");
  });
  test("a table cell under its table", () => {
    expect(resolve(screen("va03"), "tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,1]")?.id).toBe(`${TAB}/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,1]`);
  });
  test("the SAP field name: the field, not its label", () => {
    expect(resolve(screen("va01"), "VBAK-AUART")?.id).toBe("wnd[0]/usr/ctxtVBAK-AUART");
    expect(resolve(screen("va03"), "VBAK-VBELN")?.type).toBe("GuiTextField");
  });
  test("a field name is looked up on the active window first", () => {
    expect(resolve(screen("ask"), "SPOP-OPTION1")?.id).toBe("wnd[1]/usr/btnSPOP-OPTION1");
    expect(resolve(screen("f4"), "btn[0]")?.id).toBe("wnd[1]/tbar[0]/btn[0]");
  });
  test("nothing matches", () => {
    expect(resolve(screen("va01"), "ctxtNOPE")).toBeUndefined();
    expect(resolve(screen("va01"), "wnd[0]/usr/ctxtNOPE")).toBeUndefined();
  });
});

describe("sapgui ids: a selection criterion by its name (MMBE, live 2026-11-25)", () => {
  const sel: Screen = {
    transaction: "MMBE",
    program: "RMMMBESTN",
    screen: "1000",
    activeWindow: "wnd[0]",
    windows: [
      {
        id: "wnd[0]",
        title: "Stock Overview",
        controls: [
          { id: "wnd[0]/usr/txt%_MS_MATNR_%_APP_%-TEXT", type: "GuiTextField", name: "%_MS_MATNR_%_APP_%-TEXT", text: "Material", changeable: false },
          { id: "wnd[0]/usr/ctxtMS_MATNR-LOW", type: "GuiCTextField", name: "MS_MATNR-LOW", text: "", changeable: true },
          { id: "wnd[0]/usr/ctxtMS_WERKS-LOW", type: "GuiCTextField", name: "MS_WERKS-LOW", text: "", changeable: true },
          { id: "wnd[0]/usr/ctxtMS_WERKS-HIGH", type: "GuiCTextField", name: "MS_WERKS-HIGH", text: "", changeable: true },
          { id: "wnd[0]/usr/ctxtVERNU", type: "GuiCTextField", name: "VERNU", text: "1", changeable: true },
        ],
      },
    ],
  };
  test("the name, or the short id without -LOW, is the from field", () => {
    expect(resolveStrict(sel, "MS_MATNR")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtMS_MATNR-LOW" }) });
    expect(resolveStrict(sel, "ctxtMS_WERKS")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtMS_WERKS-LOW" }) });
    // -HIGH and a plain parameter are what they say.
    expect(resolveStrict(sel, "MS_WERKS-HIGH")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtMS_WERKS-HIGH" }) });
    expect(resolveStrict(sel, "VERNU")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtVERNU" }) });
    expect(resolveStrict(sel, "MS_NOPE")).toEqual({ none: true });
    // Without the report's prefix (MM60, live): the one field that ends so.
    expect(resolveStrict(sel, "ctxtWERKS-LOW")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtMS_WERKS-LOW" }) });
    expect(resolveStrict(sel, "WERKS-HIGH")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtMS_WERKS-HIGH" }) });
    expect(resolveStrict(sel, "MATNR-HIGH")).toEqual({ none: true });
  });
});

describe("sapgui ids: a field's id with the wrong type in front (FB02, live 2026-11-25)", () => {
  const fb02: Screen = {
    transaction: "FB02",
    program: "SAPMF05L",
    screen: "100",
    activeWindow: "wnd[0]",
    windows: [
      {
        id: "wnd[0]",
        title: "Change Document: Initial Screen",
        controls: [
          { id: "wnd[0]/usr/lblRF05L-BELNR", type: "GuiLabel", name: "RF05L-BELNR", text: "Document Number" },
          { id: "wnd[0]/usr/txtRF05L-BELNR", type: "GuiTextField", name: "RF05L-BELNR", text: "", changeable: true },
          { id: "wnd[0]/usr/ctxtRF05L-BUKRS", type: "GuiCTextField", name: "RF05L-BUKRS", text: "", changeable: true },
          { id: "wnd[0]/usr/lblONLY", type: "GuiLabel", name: "ONLY", text: "Only a label" },
        ],
      },
    ],
  };
  test("ctxt for txt, txt for ctxt: the field of that name", () => {
    expect(resolveStrict(fb02, "ctxtRF05L-BELNR")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/txtRF05L-BELNR" }) });
    expect(resolveStrict(fb02, "txtRF05L-BUKRS")).toEqual({ control: expect.objectContaining({ id: "wnd[0]/usr/ctxtRF05L-BUKRS" }) });
    // Never a label for a field.
    expect(resolveStrict(fb02, "txtONLY")).toEqual({ none: true });
  });
});
