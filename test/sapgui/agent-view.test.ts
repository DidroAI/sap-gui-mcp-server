import { describe, expect, test } from "bun:test";
import { compact } from "../../src/core/compact.js";
import type { Control, Screen } from "../../src/sapgui/facts.js";
import { forAgent, fullView } from "../../src/sapgui/format.js";

const c = (id: string, type: string, more: Partial<Control> = {}): Control => ({ id, type, name: id.slice(id.lastIndexOf("/") + 1), ...more });

/** FB50's header as SAP GUI 8.00 gives it (live, ECC, 2026-11-25), cut to what the view rules are about. */
const fb50: Screen = {
  transaction: "FB50",
  program: "SAPMF05A",
  screen: "1001",
  windows: [
    {
      id: "wnd[0]",
      title: "Enter G/L Account Document: Company Code 1000",
      controls: [
        c("wnd[0]", "GuiMainWindow", { text: "Enter G/L Account Document: Company Code 1000" }),
        c("wnd[0]/tbar[0]/okcd", "GuiOkCodeField"),
        c("wnd[0]/tbar[0]/btn[0]", "GuiButton", { text: "Enter", tip: "Enter", changeable: true }),
        c("wnd[0]/tbar[0]/btn[11]", "GuiButton", { text: "Post", tip: "Ctrl+S", changeable: true }),
        c("wnd[0]/tbar[0]/btn[419]", "GuiButton", { text: "New GUI Window", changeable: true }),
        c("wnd[0]/tbar[0]/btn[418]", "GuiButton", { text: "Generates shortcut", changeable: true }),
        c("wnd[0]/tbar[0]/btn[446]", "GuiButton", { text: "SAP GUI settings and actions (Ctrl+Alt+F12)", changeable: true }),
        c("wnd[0]/tbar[1]/btnvhmore", "GuiButton", { text: "More", tip: "More (Alt+F12)", changeable: true }),
        c("wnd[0]/tbar[1]/btn[9]", "GuiButton", { text: "Simulate", tip: "Simulate Document Posting   (F9)", changeable: true }),
        c("wnd[0]/usr/lblACGL_HEAD-BLDAT", "GuiLabel", { text: "Document Date" }),
        c("wnd[0]/usr/ctxtACGL_HEAD-BLDAT", "GuiCTextField", { text: "", label: "Document Date", changeable: true }),
        c("wnd[0]/usr/lblACGL_HEAD-BUKRS", "GuiLabel", { text: "Company Code" }),
        c("wnd[0]/usr/txtACGL_HEAD-BUKRS", "GuiLabel", { text: "1000" }),
        c("wnd[0]/usr/lblACGL_HEAD-SUMSOLL", "GuiLabel", { text: "Total Dr." }),
        c("wnd[0]/usr/txtACGL_HEAD-SUMSOLL", "GuiTextField", { text: "0,00", changeable: false }),
        c("wnd[0]/usr/lblHEADING", "GuiLabel", { text: "Amount Information" }),
        c("wnd[0]/sbar", "GuiStatusbar", { text: "Enter valid date", messageType: "E" }),
        c("wnd[0]/sbar/pane[0]", "GuiStatusPane", { text: "Enter valid date" }),
      ],
    },
    {
      id: "wnd[1]",
      title: "Enter Company Code",
      controls: [
        c("wnd[1]", "GuiModalWindow", { text: "Enter Company Code" }),
        c("wnd[1]/tbar[0]/btn[0]", "GuiButton", { text: "Continue", tip: "Enter", changeable: true }),
      ],
    },
  ],
};

describe("sapgui: the agent's view leaves out what SAP GUI adds around the transaction", () => {
  const view = fullView(forAgent(fb50));

  test("no window line, no status pane, no SAP GUI buttons, no Enter in the main toolbar", () => {
    expect(view).not.toContain("mainwindow");
    expect(view).not.toContain("modalwindow");
    expect(view).not.toContain("statuspane");
    for (const gone of ["btn[419]", "btn[418]", "btn[446]", "btnvhmore", "wnd[0]/tbar[0]/btn[0]"]) expect(view).not.toContain(gone);
    // The status bar, the transaction's buttons and a popup's Continue stay.
    expect(view).toContain("wnd[0]/sbar  status  E: Enter valid date");
    expect(view).toContain("wnd[0]/tbar[0]/btn[11]  button  Post");
    expect(view).toContain("wnd[0]/tbar[1]/btn[9]  button  Simulate");
    expect(view).toContain("wnd[1]/tbar[0]/btn[0]  button  Continue");
  });

  test("a label that names the field beside it is said once, on the field", () => {
    expect(view).not.toContain("lblACGL_HEAD-BLDAT");
    expect(view).toContain('ctxtACGL_HEAD-BLDAT  field  Document Date = ""  (edit)');
    // A field without a left label of its own takes the label's text.
    expect(view).not.toContain("lblACGL_HEAD-SUMSOLL");
    expect(view).toContain('txtACGL_HEAD-SUMSOLL  field  Total Dr. = "0,00"  (read-only)');
    // A value shown as text keeps its name.
    expect(view).not.toContain("lblACGL_HEAD-BUKRS");
    expect(view).toContain("txtACGL_HEAD-BUKRS  label  Company Code: 1000");
    // A label of its own (a heading) stays.
    expect(view).toContain("lblHEADING  label  Amount Information");
  });

  test("the full view keeps every control, and the screen read is not changed", () => {
    const full = fullView(fb50);
    for (const kept of ["mainwindow", "statuspane", "btn[419]", "btnvhmore", "lblACGL_HEAD-BLDAT", "lblACGL_HEAD-SUMSOLL"]) expect(full).toContain(kept);
    expect(fb50.windows[0]?.controls.find((x) => x.id.endsWith("txtACGL_HEAD-SUMSOLL"))?.label).toBeUndefined();
  });

  test("the compact view is shorter by those lines", () => {
    // The main window alone: behind a popup, the compact view keeps little of it anyway.
    const main: Screen = { ...fb50, windows: fb50.windows.slice(0, 1) };
    expect(compact(fullView(forAgent(main))).split("\n").length).toBeLessThanOrEqual(compact(fullView(main)).split("\n").length - 8);
  });
});

describe("sapgui: a selection screen's texts are said once, on their fields (MMBE, live 2026-11-25)", () => {
  const mmbe: Screen = {
    transaction: "MMBE",
    program: "RMMMBESTN",
    screen: "1000",
    windows: [
      {
        id: "wnd[0]",
        title: "Stock Overview",
        controls: [
          c("wnd[0]/usr/txt%_MS_MATNR_%_APP_%-TEXT", "GuiTextField", { name: "%_MS_MATNR_%_APP_%-TEXT", text: "Material", changeable: false }),
          c("wnd[0]/usr/txt%_MS_MATNR_%_APP_%-OPTI_PUSH", "GuiTextField", { name: "%_MS_MATNR_%_APP_%-OPTI_PUSH", text: "", label: "Material", changeable: false }),
          c("wnd[0]/usr/ctxtMS_MATNR-LOW", "GuiCTextField", { name: "MS_MATNR-LOW", text: "", label: "Material", changeable: true }),
          c("wnd[0]/usr/txt%_MS_WERKS_%_APP_%-TEXT", "GuiTextField", { name: "%_MS_WERKS_%_APP_%-TEXT", text: "Plant", changeable: false }),
          c("wnd[0]/usr/ctxtMS_WERKS-LOW", "GuiCTextField", { name: "MS_WERKS-LOW", text: "", label: "Plant", changeable: true }),
          c("wnd[0]/usr/txt%_MS_WERKS_%_APP_%-TO_TEXT", "GuiTextField", { name: "%_MS_WERKS_%_APP_%-TO_TEXT", text: "to", label: "Plant", changeable: false }),
          c("wnd[0]/usr/ctxtMS_WERKS-HIGH", "GuiCTextField", { name: "MS_WERKS-HIGH", text: "", label: "to", changeable: true }),
          c("wnd[0]/usr/txt%_MS_DISPO_%_APP_%-OPTI_PUSH", "GuiTextField", { name: "%_MS_DISPO_%_APP_%-OPTI_PUSH", text: "Select: Equal to", changeable: false }),
        ],
      },
    ],
  };
  const view = fullView(forAgent(mmbe));
  test("the criterion's name, its 'to' and an empty operator go; the fields keep them as labels", () => {
    expect(view).not.toContain("-TEXT");
    expect(view).not.toContain("MS_MATNR_%_APP_%-OPTI_PUSH");
    expect(view).toContain('ctxtMS_MATNR-LOW  field  Material = ""  (edit)');
    expect(view).toContain('ctxtMS_WERKS-HIGH  field  to = ""  (edit)');
    // An operator that is set stays: it changes what the criterion selects.
    expect(view).toContain("MS_DISPO_%_APP_%-OPTI_PUSH");
  });
});
