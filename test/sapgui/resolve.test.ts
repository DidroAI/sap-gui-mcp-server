import { describe, expect, test } from "bun:test";
import { relativeId, resolve } from "../../src/sapgui/resolve.js";
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
