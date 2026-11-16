import { describe, expect, test } from "bun:test";
import { Unsaved } from "../src/webgui/unsaved.js";

const view = (transaction: string, status = "", save = "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)", screen = "100") =>
  [`TRANSACTION ${transaction}  PROGRAM ZPROG  SCREEN ${screen}  SYSTEM XYZ (100) host`, 'WINDOW wnd[0]  "Synthetic"', save, ...(status ? [`wnd[0]/sbar  status  ${status}`] : [])].filter(Boolean).join("\n");
const EDIT = view("ZT02");

describe("input the agent made and a command drops", () => {
  test("leaving a transaction after typing says how many values are lost unless saved", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    u.typed(EDIT);
    u.seen(view("ZT02"));
    u.typed(EDIT);
    expect(u.left()).toBe("SAP left ZT02 without asking: the 2 values set there since its last success message are lost unless saved before.");
    // Said once.
    expect(u.left()).toBeUndefined();
  });

  test("nothing is said when the agent typed nothing, or SAP answered with a success message since", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    expect(u.left()).toBeUndefined();
    u.typed(EDIT);
    u.seen(view("ZT02", "S: Order 1 has been saved"));
    expect(u.left()).toBeUndefined();
    // The same success message still on the screen does not hide what is typed after it.
    u.typed(EDIT);
    u.seen(view("ZT02", "S: Order 1 has been saved"));
    expect(u.left()).toBe("SAP left ZT02 without asking: the value set there since its last success message is lost unless saved before.");
  });

  test("an error or a warning does not count as saved; another transaction starts the count again", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    u.typed(EDIT);
    u.seen(view("ZT02", "E: Fill out all required entry fields"));
    u.seen(view("ZT03"));
    expect(u.left()).toBeUndefined();
    u.typed(EDIT);
    u.seen(view("ZT03", "W: Check the date"));
    expect(u.left()).toContain("SAP left ZT03 without asking");
  });

  test("R4: what is typed where SAP cannot save is not counted: a display transaction, an initial screen, selection criteria", () => {
    const u = new Unsaved();
    // No Save in the system toolbar: the document number on the initial screen of a display transaction.
    u.seen(view("ZT03", "", ""));
    u.typed(view("ZT03", "", ""));
    expect(u.left()).toBeUndefined();
    // A report's selection screen: its btn[11] saves a variant.
    const selection = view("ZT05", "", "wnd[0]/tbar[0]/btn[11]  button  Save as Variant... (Ctrl+S)", "1000");
    u.seen(selection);
    u.typed(selection);
    u.typed(`${view("ZT05", "", "wnd[0]/tbar[0]/btn[11]  button  Variante sichern", "0500")}\nwnd[0]/usr/btn%_S_NAME_%_APP_%-VALU_PUSH  button  Multiple selection`);
    expect(u.left()).toBeUndefined();
    // Typed on the initial screen (no Save), then on the screen that saves: one value counts.
    u.seen(view("ZT02", "", ""));
    u.typed(view("ZT02", "", ""));
    u.typed(EDIT);
    expect(u.left()).toBe("SAP left ZT02 without asking: the value set there since its last success message is lost unless saved before.");
  });
});
