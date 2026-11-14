import { describe, expect, test } from "bun:test";
import { decide, policyFromEnv } from "../src/core/guard.js";
import { assessAction, assessControl, keyOf } from "../src/fiori/risk.js";
import type { ControlFacts } from "../src/fiori/ui5.js";

const button = (text: string, more: Partial<ControlFacts> = {}): ControlFacts => ({ type: "sap.m.Button", id: `__button${text.length}`, text, buttonType: "Default", ...more });
const V4 = "my.app::SalesOrderObjectPage--fe::";
const V2 = "my.app::sap.suite.ui.generic.template.ObjectPage.view.Details::C_Order--";
const dialog = (title: string, text = "", type = "sap.m.Dialog") => ({ dialog: { type, title, text } });

/** control, expected risk, expected rule */
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
  ["a button nobody knows", button("Related Apps"), "navigate", "default"],
  // press handler
  ["handler onSave", button("Done", { handlers: ["onSave"] }), "commit", "press handler that writes"],
  // type and place
  ["emphasized footer button", button("Finish", { buttonType: "Emphasized", inFooter: true }), "commit", "emphasized button of a footer toolbar"],
  ["plain footer button", button("Finish", { inFooter: true }), "navigate", "default"],
  ["emphasized dialog button", button("Assign", { buttonType: "Emphasized", ...dialog("Assign Responsible") }), "commit", "emphasized button of a dialog"],
  ["OK of a delete question", button("OK", { buttonType: "Emphasized", ...dialog("Delete", "Delete object 4711?", "sap.m.MessageBox") }), "commit", "agrees to a dialog that writes"],
  ["OK of a sign-out question", button("OK", { buttonType: "Emphasized", ...dialog("Sign Out", "Are you sure you want to sign out?", "sap.m.MessageBox") }), "navigate", "agrees to a dialog"],
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
      const a = assessControl(facts);
      expect({ risk: a.risk, rule: a.rule }).toEqual({ risk, rule });
    });

  test("the reason names the control", () => {
    expect(assessControl(button("Save")).reason).toBe('button "Save": text says it writes');
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
  test("an action the surface does not know cannot be ruled safe", () => {
    expect(assessAction({ do: "drag", id: "x" }, save).risk).toBe("commit");
  });
  test("a Save button is refused by default and held in confirm mode", () => {
    const a = assessAction({ do: "press", id: "Save" }, save);
    expect(decide(policyFromEnv({}), { do: "press", id: "Save" }, a)).toMatchObject({ run: false, refused: expect.stringContaining("writes are off") });
    expect(decide(policyFromEnv({ SAP_WRITE: "confirm" }), { do: "press", id: "Save" }, a)).toMatchObject({ run: false, confirm: expect.stringContaining("Save") });
  });
});
