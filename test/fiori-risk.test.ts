import { describe, expect, test } from "bun:test";
import { decide, policyFromEnv } from "../src/core/guard.js";
import { assessAction, assessControl, keyOf } from "../src/fiori/risk.js";
import type { ControlFacts } from "../src/fiori/ui5.js";

const button = (text: string, more: Partial<ControlFacts> = {}): ControlFacts => ({ type: "sap.m.Button", id: `__button${text.length}`, text, buttonType: "Default", ...more });
const V4 = "my.app::SalesOrderObjectPage--fe::";
const V2 = "my.app::sap.suite.ui.generic.template.ObjectPage.view.Details::C_Order--";
const dialog = (title: string, text = "", type = "sap.m.Dialog") => ({ dialog: { type, title, text } });

/** control, expected risk, expected rule */
const EN = { language: "en-US" };

const TABLE: [string, ControlFacts, "read" | "navigate" | "commit", string][] = [
  // ids of Fiori elements standard actions
  ["V4 footer Save", button("Save", { id: `${V4}FooterBar::StandardAction::Save`, buttonType: "Emphasized", inFooter: true }), "commit", "standard action that writes (id)"],
  ["V4 footer Save in another language", button("Sauvegarder", { id: `${V4}FooterBar::StandardAction::Save`, inFooter: true }), "commit", "standard action that writes (id)"],
  ["V4 table Create", button("Create", { id: `${V4}table::Items::LineItem::StandardAction::Create` }), "commit", "standard action that writes (id)"],
  ["V4 table Delete", button("Delete", { id: `${V4}table::Items::LineItem::StandardAction::Delete` }), "commit", "standard action that writes (id)"],
  ["V4 header Edit", button("Edit", { id: `${V4}StandardAction::Edit`, buttonType: "Emphasized" }), "navigate", "standard action that does not write (id)"],
  ["V4 footer Cancel", button("Cancel", { id: `${V4}FooterBar::StandardAction::Cancel`, inFooter: true }), "navigate", "standard action that does not write (id)"],
  ["V4 bound action", button("Set to Booked", { id: `${V4}DataFieldForAction::com.app.SetBooked` }), "commit", "back-end action (id)"],
  ["V2 activate", button("Save", { id: `${V2}activate`, buttonType: "Emphasized", inFooter: true }), "commit", "standard action that writes (id)"],
  ["V2 function import", button("Release Block", { id: `${V2}action::C_Order_Entities::ReleaseBlock` }), "commit", "back-end action (id)"],
  ["V2 edit", button("Edit", { id: `${V2}edit`, buttonType: "Emphasized" }), "navigate", "standard action that does not write (id)"],
  ["list report Go", button("Go", { id: `${V2}listReportFilter-btnGo`, buttonType: "Emphasized", inFilterBar: true }), "read", "value help, filter or search (id)"],
  ["V4 filter bar Go", button("Go", { id: `${V4}FilterBar-btnSearch`, buttonType: "Emphasized" }), "read", "value help, filter or search (id)"],
  ["adapt filters", button("Adapt Filters (1)", { id: `${V2}listReportFilter-btnFilters` }), "read", "value help, filter or search (id)"],
  // text
  ["Create by text", button("Create"), "commit", "text says it writes"],
  ["Post Goods Issue", button("Post Goods Issue"), "commit", "text says it writes"],
  ["Reject All Items", button("Reject All Items"), "commit", "text says it writes"],
  ["German Sichern", button("Sichern"), "commit", "text says it writes"],
  ["French Enregistrer", button("Enregistrer"), "commit", "text says it writes"],
  ["menu entry Delete", { type: "sap.ui.unified.MenuItem", id: "__item9", text: "Delete" }, "commit", "text says it writes"],
  ["Display Posting", button("Display Posting Details"), "navigate", "text says it does not write"],
  ["Cancel", button("Cancel", { buttonType: "Emphasized", inFooter: true }), "navigate", "text says it does not write"],
  ["Show Details", button("Show Details"), "navigate", "text says it does not write"],
  // a button that is not known to be safe is a commit
  ["a button nobody knows", button("Related Apps"), "commit", "button that is not known to be safe"],
  ["Apply", button("Apply"), "commit", "button that is not known to be safe"],
  ["Remove", button("Remove"), "commit", "text says it writes"],
  ["Assign", button("Assign"), "commit", "button that is not known to be safe"],
  ["Cancel Order", button("Cancel Order"), "commit", "text says it writes"],
  ["Edit by its text only", button("Edit"), "commit", "button that is not known to be safe"],
  ["Sign Out", { type: "sap.m.StandardListItem", id: "__item7", text: "Sign Out", ...dialog("", "", "sap.m.Popover") }, "commit", "text says it writes"],
  ["Yes of a question that names no write", button("Yes", { ...dialog("Warning", "Do you want to continue?", "sap.m.MessageBox") }), "commit", "button that is not known to be safe"],
  ["Yes of a delete question", button("Yes", { ...dialog("Delete", "Delete object 4711?", "sap.m.MessageBox") }), "commit", "agrees to a dialog that writes"],
  ["an icon with a press handler nobody knows", { type: "sap.ui.core.Icon", id: "__icon4", text: "", icon: "decline", handlers: ["onPress"] }, "commit", "control with a press handler that is not known to be safe"],
  ["an icon whose handler deletes", { type: "sap.ui.core.Icon", id: "__icon5", text: "", icon: "sys-cancel", handlers: ["onDeleteRow"] }, "commit", "press handler that writes"],
  // known safe: the words of the shared table, and what only opens or moves
  ["Back", button("Back"), "navigate", "text says it does not write"],
  ["Close", button("Close", { buttonType: "Emphasized", ...dialog("Details") }), "navigate", "text says it does not write"],
  ["Refresh", button("Refresh"), "navigate", "text says it does not write"],
  ["Next", button("Next"), "navigate", "text says it does not write"],
  ["Sort", button("Sort"), "navigate", "text says it does not write"],
  ["Filter", button("Filter"), "navigate", "text says it does not write"],
  ["Expand All", button("Expand All"), "navigate", "text says it does not write"],
  ["Go by its text", button("Go"), "navigate", "text says it does not write"],
  ["Select All", button("Select All"), "navigate", "text says it does not write"],
  ["Help", button("Help"), "navigate", "text says it does not write"],
  ["a search icon without a text", button("", { icon: "search" }), "navigate", "icon says it does not write"],
  ["an icon nobody knows, without a text", button("", { icon: "wrench" }), "commit", "button that is not known to be safe"],
  ["a link without an address", { type: "sap.m.Link", id: "__link2", text: "Sold-To Party 4711" }, "navigate", "link"],
  ["a link that says it deletes", { type: "sap.m.Link", id: "__link3", text: "Delete" }, "commit", "text says it writes"],
  ["a button that opens a menu", { type: "sap.m.MenuButton", id: "__mb1", text: "Actions" }, "navigate", "button that opens a menu"],
  ["the overflow button of a toolbar", button("", { id: "app--toolbar-overflowButton", icon: "overflow" }), "read", "value help, filter or search (id)"],
  ["a text with no press handler", { type: "sap.m.Text", id: "__text1", text: "Delete" }, "navigate", "default"],
  // press handler
  ["handler onSave", button("Done", { handlers: ["onSave"] }), "commit", "press handler that writes"],
  // type and place
  ["emphasized footer button", button("Finish", { buttonType: "Emphasized", inFooter: true }), "commit", "emphasized button of a footer toolbar"],
  ["plain footer button", button("Finish", { inFooter: true }), "commit", "button that is not known to be safe"],
  ["emphasized dialog button", button("Assign", { buttonType: "Emphasized", ...dialog("Assign Responsible") }), "commit", "emphasized button of a dialog"],
  ["OK of a delete question", button("OK", { buttonType: "Emphasized", ...dialog("Delete", "Delete object 4711?", "sap.m.MessageBox") }), "commit", "agrees to a dialog that writes"],
  ["OK of a sign-out question", button("OK", { buttonType: "Emphasized", ...dialog("Sign Out", "Are you sure you want to sign out?", "sap.m.MessageBox") }), "commit", "agrees to a dialog that writes"],
  ["OK of a message", button("OK", { buttonType: "Emphasized", ...dialog("Information", "The list was refreshed.", "sap.m.MessageBox") }), "navigate", "agrees to a dialog"],
  ["OK of a value help", button("OK", { buttonType: "Emphasized", inValueHelp: true, ...dialog("Sold-to Party", "Items (215) Create Date") }), "navigate", "agrees to a dialog"],
  ["a button of a value help", button("Advanced Search", { inValueHelp: true, ...dialog("Sold-to Party") }), "read", "button of a filter bar or value help"],
  ["Save in a filter bar (a view)", button("Save View", { inFilterBar: true }), "commit", "text says it writes"],
  // things that are not buttons
  ["tile named Create Sales Orders", { type: "sap.m.GenericTile", id: "__tile3", text: "Create Sales Orders" }, "navigate", "row, tile, tab or list entry"],
  ["table row", { type: "sap.m.ColumnListItem", id: "x-__clone3", text: "" }, "navigate", "row, tile, tab or list entry"],
  ["tab", { type: "sap.m.IconTabFilter", id: "x-anchor", text: "Delete Log" }, "navigate", "row, tile, tab or list entry"],
  ["link with an address", { type: "sap.m.Link", id: "__link1", text: "Create Order", href: "#SalesOrder-create" }, "navigate", "link with an address"],
  ["entry of a menu popover", { type: "sap.m.StandardListItem", id: "__item4", text: "Delete Variant", ...dialog("", "", "sap.m.Popover") }, "commit", "text says it writes"],
  ["entry of a list", { type: "sap.m.StandardListItem", id: "__item5", text: "Create Sales Orders - VA01" }, "navigate", "row, tile, tab or list entry"],
];

describe("fiori risk table", () => {
  for (const [name, facts, risk, rule] of TABLE)
    test(name, () => {
      const a = assessControl(facts, EN);
      expect({ risk: a.risk, rule: a.rule }).toEqual({ risk, rule });
    });

  test("in a language the word table does not cover, a button is safe by its id alone", () => {
    for (const language of ["ja", "pt-BR", "", undefined]) {
      const ctx = { language };
      for (const text of ["Back", "Close", "Refresh", "Show Details", "Voltar", "戻る"]) expect([text, assessControl(button(text), ctx).risk]).toEqual([text, "commit"]);
      expect(assessControl(button("Cancel", { buttonType: "Emphasized", inFooter: true }), ctx).risk).toBe("commit");
      // By id, by type and by place nothing changes.
      expect(assessControl(button("キャンセル", { id: `${V4}FooterBar::StandardAction::Cancel`, inFooter: true }), ctx).risk).toBe("navigate");
      expect(assessControl(button("実行", { id: `${V2}listReportFilter-btnGo`, inFilterBar: true }), ctx).risk).toBe("read");
      expect(assessControl(button("保存", { id: `${V4}FooterBar::StandardAction::Save` }), ctx).risk).toBe("commit");
      expect(assessControl({ type: "sap.m.IconTabFilter", id: "x-anchor", text: "明細" }, ctx).risk).toBe("navigate");
      expect(assessControl({ type: "sap.m.ColumnListItem", id: "x-__clone3", text: "" }, ctx).risk).toBe("navigate");
      expect(assessControl(button("OK", { ...dialog("情報", "完了", "sap.m.MessageBox") }), ctx).risk).toBe("navigate");
      // Commit words are read in every language.
      expect(assessControl(button("Gravar"), ctx).rule).toBe("text says it writes");
    }
    expect(assessControl(button("Zurück"), { language: "de-DE" }).risk).toBe("navigate");
    expect(assessControl(button("Actualiser"), { language: "fr" }).risk).toBe("navigate");
    expect(assessControl(button("Buscar"), { language: "es-ES" }).risk).toBe("navigate");
  });

  test("the reason names the control", () => {
    expect(assessControl(button("Save")).reason).toBe('button "Save": text says it writes');
    expect(assessControl(button("Apply"), EN).reason).toBe('button "Apply": button that is not known to be safe');
  });
});

describe("fiori actions", () => {
  const save = button("Save", { id: `${V4}FooterBar::StandardAction::Save` });
  test("press, click and select follow the control", () => {
    for (const d of ["press", "click", "select", "dblclick"]) expect(assessAction({ do: d, id: "x" }, save).risk).toBe("commit");
    expect(assessAction({ do: "press", id: "x" }, button("Go", { id: "a--listReportFilter-btnGo" })).risk).toBe("read");
  });
  test("input is unsaved until a button saves it; filters and value helps change nothing", () => {
    const field: ControlFacts = { type: "sap.m.Input", id: "a--Description", text: "" };
    expect(assessAction({ do: "set", id: "x", value: "1" }, field).risk).toBe("navigate");
    expect(assessAction({ do: "check", id: "x" }, { ...field, type: "sap.m.CheckBox" }).risk).toBe("navigate");
    expect(assessAction({ do: "set", id: "x", value: "1" }, { ...field, inFilterBar: true }).risk).toBe("read");
    expect(assessAction({ do: "combo", id: "x", key: "A" }, { ...field, inValueHelp: true }).risk).toBe("read");
    expect(assessAction({ do: "f4", id: "x" }, field).risk).toBe("read");
    expect(assessAction({ do: "scroll", how: "down" }, undefined).risk).toBe("read");
  });
  test("keys", () => {
    expect(keyOf({ do: "key", key: 0 })?.press).toBe("Enter");
    expect(keyOf({ do: "key", key: "escape" })?.press).toBe("Escape");
    expect(keyOf({ do: "key", key: 12 })?.press).toBe("Escape");
    expect(keyOf({ do: "key", key: "Ctrl+S" })?.risk).toBe("commit");
    expect(keyOf({ do: "key", key: 8 })).toBeUndefined();
    expect(assessAction({ do: "key", key: "Enter" }, undefined).risk).toBe("navigate");
    expect(assessAction({ do: "key", key: 11 }, undefined).risk).toBe("commit");
    expect(assessAction({ do: "key", key: "Control+Enter" }, undefined).risk).toBe("commit");
    expect(assessAction({ do: "key", key: "F8" }, undefined).risk).toBe("commit");
  });
  test("Enter is a commit when it would press a button that writes", () => {
    expect(assessAction({ do: "key", key: "Enter" }, undefined, { focused: save }).risk).toBe("commit");
    expect(assessAction({ do: "key", key: 0 }, undefined, { focused: { type: "sap.m.Input", id: "i", text: "" }, dialogDefault: button("Delete", dialog("Delete")) }).risk).toBe("commit");
    expect(assessAction({ do: "key", key: 0 }, undefined, { dialogDefault: button("OK", { inValueHelp: true, ...dialog("Customer") }) }).risk).toBe("navigate");
  });
  test("Enter and Space on a focused button that is not known to be safe are commits", () => {
    const apply = button("Apply");
    expect(assessAction({ do: "key", key: "Enter" }, undefined, { ...EN, focused: apply }).risk).toBe("commit");
    expect(assessAction({ do: "key", key: "Space" }, undefined, { ...EN, focused: apply }).risk).toBe("commit");
    expect(assessAction({ do: "key", key: "Space" }, undefined, { ...EN, focused: save }).reason).toContain("Space would press");
    expect(assessAction({ do: "key", key: "Space" }, undefined, { ...EN, focused: button("Close") }).risk).toBe("navigate");
    expect(assessAction({ do: "key", key: "Space" }, undefined, { ...EN, focused: { type: "sap.m.CheckBox", id: "c", text: "Flag" } }).risk).toBe("navigate");
    // Space does not press a dialog's default button.
    expect(assessAction({ do: "key", key: "Space" }, undefined, { ...EN, dialogDefault: button("Delete", dialog("Delete")) }).risk).toBe("navigate");
    // The language decides for the focused button too.
    expect(assessAction({ do: "key", key: "Enter" }, undefined, { language: "ja", focused: button("Close") }).risk).toBe("commit");
  });
  test("an id the screen does not have fails as no such control, before any risk is judged", () => {
    for (const d of ["press", "click", "select", "dblclick", "set"]) expect(() => assessAction({ do: d, id: "ghost", value: "1" }, undefined, EN)).toThrow('No control "ghost" on this screen');
    // Without an id there is no control to name: a press still cannot be ruled safe.
    expect(assessAction({ do: "press" }, undefined, EN).risk).toBe("commit");
  });
  test("check on a toggle button is a press of that button", () => {
    expect(assessAction({ do: "check", id: "x" }, { type: "sap.m.ToggleButton", id: "t", text: "Block" }, EN).risk).toBe("commit");
  });
  test("an action the surface does not know cannot be ruled safe", () => {
    expect(assessAction({ do: "drag", id: "x" }, save).risk).toBe("commit");
  });
  test("a Save button is refused by default and held in confirm mode", () => {
    const a = assessAction({ do: "press", id: "Save" }, save);
    expect(decide(policyFromEnv({}), { do: "press", id: "Save" }, a)).toMatchObject({ run: false, refused: expect.stringContaining("writes are off") });
    expect(decide(policyFromEnv({ SAP_WRITE: "confirm" }), { do: "press", id: "Save" }, a)).toMatchObject({ run: false, confirm: expect.stringContaining("Save") });
  });
});

describe("Fiori: signing out is its own risk", () => {
  test("Sign Out is flagged closes and refused even with writing on", () => {
    const a = assessAction({ do: "press", id: "__button9" }, button("Sign Out"), EN);
    expect(a).toMatchObject({ risk: "commit", closes: true });
    expect(decide(policyFromEnv({ SAP_WRITE: "on" }), { do: "press", id: "__button9" }, a).run).toBe(false);
    expect(assessAction({ do: "press", id: "__button4" }, button("Back"), EN).closes).toBeUndefined();
  });
});
