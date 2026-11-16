import { describe, expect, test } from "bun:test";
import { names, resolveId, severalText, shortIds } from "../src/core/ids.js";

// Synthetic ids, in the shape SAP GUI scripting gives them.
const TREE = "wnd[0]/usr/tabsZ_TABSTRIP*/tabpT\\08/ssubBODY:ZPROG:4152/subTEXT:ZLIB:2100/cntlSPLITTER/shellcont/shellcont/shell/shellcont[0]/shell";
const EDITOR = "wnd[0]/usr/tabsZ_TABSTRIP*/tabpT\\08/ssubBODY:ZPROG:4152/subTEXT:ZLIB:2100/cntlSPLITTER/shellcont/shellcont/shell/shellcont[1]/shell";
const GRID = "wnd[0]/usr/cntlGRID1/shellcont/shell";
const IDS = [
  "wnd[0]/tbar[0]/okcd",
  "wnd[0]/tbar[0]/btn[3]",
  "wnd[0]/tbar[1]/btn[3]",
  "wnd[0]/tbar[1]/btn[8]",
  "wnd[0]/usr/ctxtZHDR-TYPE",
  "wnd[0]/usr/subA:ZPROG:0110/txtZHDR-NOTE",
  "wnd[0]/usr/subB:ZPROG:0120/txtZHDR-NOTE",
  TREE,
  EDITOR,
  "wnd[0]/sbar",
];

describe("names: does a handle name an id", () => {
  test("the id itself, its last segment, and any earlier segments in order", () => {
    expect(names(TREE, TREE)).toBe(true);
    expect(names(TREE, "shell")).toBe(true);
    expect(names(TREE, "shellcont[0]/shell")).toBe(true);
    expect(names(TREE, "cntlSPLITTER/shellcont[0]/shell")).toBe(true);
    expect(names(TREE, "cntlSPLITTER/shell")).toBe(true);
  });
  test("not another last segment, a segment that is not there, or segments out of order", () => {
    expect(names(TREE, "shellcont[1]/shell")).toBe(false);
    expect(names(TREE, "cntlGRID1/shell")).toBe(false);
    expect(names(TREE, "shellcont[0]/cntlSPLITTER/shell")).toBe(false);
    expect(names(TREE, "shellcont[0]")).toBe(false);
  });
});

describe("shortIds: the handle the compact view shows", () => {
  const h = shortIds(IDS);
  test("the last segment when it is unique", () => {
    expect(h.get("wnd[0]/usr/ctxtZHDR-TYPE")).toBe("ctxtZHDR-TYPE");
    expect(h.get("wnd[0]/tbar[0]/okcd")).toBe("okcd");
    expect(h.get("wnd[0]/sbar")).toBe("sbar");
    expect(h.get("wnd[0]/tbar[1]/btn[8]")).toBe("btn[8]");
  });
  test("as few earlier segments as make it unique", () => {
    expect(h.get("wnd[0]/usr/subA:ZPROG:0110/txtZHDR-NOTE")).toBe("subA:ZPROG:0110/txtZHDR-NOTE");
    expect(h.get("wnd[0]/tbar[0]/btn[3]")).toBe("tbar[0]/btn[3]");
    expect(h.get("wnd[0]/tbar[1]/btn[3]")).toBe("tbar[1]/btn[3]");
  });
  test("two shells under a wildcard tab strip get short handles, each naming one control", () => {
    expect(h.get(TREE)).toBe("cntlSPLITTER/shellcont[0]/shell");
    expect(h.get(EDITOR)).toBe("cntlSPLITTER/shellcont[1]/shell");
    for (const id of IDS) expect(resolveId(IDS, h.get(id) ?? "")).toEqual({ id });
  });
  test("a shell keeps its container even when it is the only one", () => {
    expect(shortIds([GRID, "wnd[0]/sbar"]).get(GRID)).toBe("cntlGRID1/shell");
  });
  test("the same control in a popup and behind it: the window tells them apart", () => {
    const two = shortIds(["wnd[0]/usr/ctxtX", "wnd[1]/usr/ctxtX"]);
    expect(two.get("wnd[1]/usr/ctxtX")).toBe("wnd[1]/ctxtX");
    expect(two.get("wnd[0]/usr/ctxtX")).toBe("wnd[0]/ctxtX");
  });
  test("an id listed twice counts once", () => {
    expect(shortIds(["wnd[0]/usr/subA/txtX", "wnd[0]/usr/subA/txtX"]).get("wnd[0]/usr/subA/txtX")).toBe("txtX");
  });
});

describe("resolveId: which control an id means", () => {
  test("a full id, a last segment, a handle", () => {
    expect(resolveId(IDS, EDITOR)).toEqual({ id: EDITOR });
    expect(resolveId(IDS, "ctxtZHDR-TYPE")).toEqual({ id: "wnd[0]/usr/ctxtZHDR-TYPE" });
    expect(resolveId(IDS, "shellcont[1]/shell")).toEqual({ id: EDITOR });
    expect(resolveId(IDS, " btn[8] ")).toEqual({ id: "wnd[0]/tbar[1]/btn[8]" });
  });
  test("a handle that names several controls is not guessed", () => {
    expect(resolveId(IDS, "shell")).toEqual({ several: [TREE, EDITOR] });
    expect(resolveId(IDS, "btn[3]")).toEqual({ several: ["wnd[0]/tbar[0]/btn[3]", "wnd[0]/tbar[1]/btn[3]"] });
    expect(severalText("shell", [TREE, EDITOR], shortIds(IDS))).toBe('"shell" names 2 controls on this screen: cntlSPLITTER/shellcont[0]/shell, cntlSPLITTER/shellcont[1]/shell. Use one of these ids.');
  });
  test("of a popup and the window behind it, the popup's control", () => {
    const ids = ["wnd[0]/tbar[0]/btn[0]", "wnd[1]/tbar[0]/btn[0]", "wnd[0]/usr/ctxtX", "wnd[1]/usr/ctxtX"];
    expect(resolveId(ids, "btn[0]")).toEqual({ id: "wnd[1]/tbar[0]/btn[0]" });
    expect(resolveId(ids, "ctxtX")).toEqual({ id: "wnd[1]/usr/ctxtX" });
    expect(resolveId(ids, "wnd[0]/ctxtX")).toEqual({ id: "wnd[0]/usr/ctxtX" });
  });
  test("a full id that is not on the screen: its last segment, by the same rule", () => {
    expect(resolveId(IDS, "wnd[0]/usr/wrong/path/ctxtZHDR-TYPE")).toEqual({ id: "wnd[0]/usr/ctxtZHDR-TYPE" });
    expect(resolveId(IDS, "wnd[0]/usr/wrong/shell")).toEqual({ several: [TREE, EDITOR] });
  });
  test("an id written nearly right names its control when it then names one only (agent runs, 2026-11)", () => {
    const T = "wnd[0]/usr/tabsTAB/tabpT\\01/ssubBODY:ZPROG:4400/tblZPROGTC_ITEMS";
    const ids = [
      "wnd[0]/usr/lblLIKP-VBELN",
      "wnd[0]/usr/ctxtLIKP-VBELN",
      T,
      `${T}/txtZITM-POSNR[0,0]`,
      `${T}/ctxtZITM-MATNR[1,0]`,
      `${T}/txtZITM-MENGE[3,0]`,
      `${T}/ctxtZITM-MATNR[1,1]`,
      `${T}/txtZITM-MENGE[3,1]`,
      "wnd[0]/tbar[0]/btn[11]",
    ];
    // Another case: SAP names are upper case.
    expect(resolveId(ids, "likp-vbeln")).toEqual({ id: "wnd[0]/usr/ctxtLIKP-VBELN" });
    expect(resolveId(ids, "ctxtlikp-vbeln")).toEqual({ id: "wnd[0]/usr/ctxtLIKP-VBELN" });
    // A cell with its column counted wrong: the field's name and the row say which cell.
    expect(resolveId(ids, "ctxtZITM-MATNR[3,0]")).toEqual({ id: `${T}/ctxtZITM-MATNR[1,0]` });
    expect(resolveId(ids, "ZITM-MENGE[2,1]")).toEqual({ id: `${T}/txtZITM-MENGE[3,1]` });
    // The table's own id with a cell's place: the cell of that table there.
    expect(resolveId(ids, "tblZPROGTC_ITEMS[1,1]")).toEqual({ id: `${T}/ctxtZITM-MATNR[1,1]` });
    // A row the screen does not hold, a field the table does not have: nothing, never another row's cell.
    expect(resolveId(ids, "ctxtZITM-MATNR[1,7]")).toEqual({ none: true });
    expect(resolveId(ids, "ctxtZITM-WERKS[4,0]")).toEqual({ none: true });
    expect(resolveId(ids, "tblZPROGTC_ITEMS[2,0]")).toEqual({ none: true });
    // Two candidates are never guessed among.
    expect(resolveId([...ids, "wnd[0]/usr/subX/ctxtLIKP-VBELN"], "likp-vbeln")).toEqual({ none: true });
    // An id of a window stays in that window.
    expect(resolveId(ids, "wnd[1]/usr/ctxtlikp-vbeln")).toEqual({ none: true });
  });
  test("an id of another screen names nothing", () => {
    expect(resolveId(IDS, "ctxtZOLD-FIELD")).toEqual({ none: true });
    expect(resolveId(IDS, "cntlGRID1/shell")).toEqual({ none: true });
    expect(resolveId(IDS, "")).toEqual({ none: true });
  });
});
