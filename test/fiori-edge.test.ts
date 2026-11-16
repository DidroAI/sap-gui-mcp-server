/**
 * Edge cases of the Fiori surface (round 3): a control that throws while it
 * is read, grid tables with a selection plugin, pressing a row that holds
 * links, filter values the page folds away, the draft's exits and the
 * launchpad's own entries in the guard, and opening an app by its intent.
 * Synthetic pages: no SAP data.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import { ActionError } from "../src/core/types.js";
import { assessAction, assessControl, intentOf } from "../src/fiori/risk.js";
import { type ControlFacts, ui5Control, ui5Look } from "../src/fiori/ui5.js";
import { FakeControl, FakeEl, installPage, item, marked, removePage } from "./fiori-fixtures.js";

afterAll(removePage);

const EN = { language: "en-US" };
const button = (text: string, more: Partial<ControlFacts> = {}): ControlFacts => ({ type: "sap.m.Button", id: `__button${text.length}`, text, buttonType: "Default", ...more });

/** A table cell: what it matches, and whether it holds a link. */
function cell(cls: string, link: boolean): FakeEl {
  const td = new FakeEl(`td-${cls}-${link}`, "td");
  td.matches = (sel: string) => sel.split(",").some((s) => s.trim() === `.${cls}`);
  td.querySelector = ((sel: string) => (link && sel.includes("a,") ? new FakeEl("a", "a") : sel.includes("-imgNav") && cls === "sapMListTblNavCol" ? new FakeEl("nav") : null)) as never;
  return td;
}

describe("FIORI-01: a grid table with a selection plugin", () => {
  const plugin = { isA: (t: string) => t === "sap.ui.table.plugins.SelectionPlugin", isIndexSelected: (i: number) => i === 1 };
  const refuses = () => {
    throw new Error("Unsupported operation: sap.ui.table.Table#getSelectedIndices must not be called if a selection plugin is applied.");
  };
  const table = new FakeControl({
    type: "sap.ui.table.Table",
    id: "app::List--items",
    isA: ["sap.ui.table.Table"],
    methods: { getDependents: () => [plugin], getSelectionMode: () => "MultiToggle", getSelectedIndices: refuses, isIndexSelected: refuses, getRows: (() => rows) as never, getColumns: () => [] },
  });
  const row = (i: number) =>
    new FakeControl({
      type: "sap.ui.table.Row",
      id: `app::List--items-rows-row${i}`,
      isA: ["sap.ui.table.Row"],
      parent: table,
      methods: { getIndex: () => i, getCells: () => [{ getDomRef: () => Object.assign(new FakeEl(`c${i}`, "input"), { value: `Item ${i}`, type: "text" }) }] },
    });
  const rows = [row(0), row(1)];
  const page = () => installPage([new FakeControl({ type: "sap.m.Title", id: "app::List--title", props: { text: "Items" } }), table, ...rows]);

  test("the view is read, and the plugin says which row is selected", () => {
    page();
    const view = ui5Look({ compact: true });
    expect(view).toContain('Title #title "Items"');
    expect(view).toContain("Row #items-rows-row0 row: [ ] Item 0");
    expect(view).toContain("Row #items-rows-row1 row: [x] Item 1");
    expect(view).not.toContain("not read");
  });
  test("check asks the plugin too", () => {
    page();
    expect(ui5Control({ handle: "items-rows-row1", op: "check", value: true })).toMatchObject({ status: "DONE", note: expect.stringContaining("already checked") });
    expect(ui5Control({ handle: "items-rows-row0", op: "check", value: true }).status).toBe("TARGET");
  });
  test("a control that throws while it is read costs its own line, not the view", () => {
    const broken = new FakeControl({ type: "my.app.Odd", id: "app::List--odd", props: { text: "x" } });
    broken.getMetadata = () => ({
      getName: () => "my.app.Odd",
      getAllProperties: () => {
        throw new Error("Unsupported operation: this control cannot be read");
      },
      getAllEvents: () => ({}),
    });
    installPage([new FakeControl({ type: "sap.m.Title", id: "app::List--title", props: { text: "Before" } }), broken, new FakeControl({ type: "sap.m.Title", id: "app::List--after", props: { text: "After" } })]);
    for (const compact of [true, false]) {
      const view = ui5Look({ compact });
      expect(view).toContain("Before");
      expect(view).toContain("After");
    }
    expect(ui5Look({ compact: true })).toContain("my.app.Odd #odd [not read: Unsupported operation: this control cannot be read]");
  });
});

describe("FIORI-02: pressing a row presses the row, not a link inside it", () => {
  const list = new FakeControl({ type: "sap.m.Table", id: "app::List--table", isA: ["sap.m.Table", "sap.m.ListBase"], methods: { getMode: () => "None", getColumns: () => [] } });
  const make = (cells: FakeEl[]) => {
    const r = new FakeControl({ type: "sap.m.ColumnListItem", id: "app::List--row1", isA: ["sap.m.ColumnListItem", "sap.m.ListItemBase"], parent: list, methods: { getType: () => "Navigation", getCells: () => [] } });
    (r.dom as FakeEl).querySelectorAll = ((sel: string) => (sel.startsWith("td") ? cells : [])) as never;
    installPage([list, r]);
    return cells;
  };
  test("the navigation arrow's cell, when the row has one", () => {
    const cells = make([cell("status", true), cell("sapMListTblNavCol", false)]);
    expect(ui5Control({ handle: "row1", op: "click" }).status).toBe("TARGET");
    expect(cells[1]?.hasAttribute("data-sap-mcp-target")).toBe(true);
    expect(cells[0]?.hasAttribute("data-sap-mcp-target")).toBe(false);
  });
  test("else a cell without a link, a button or an input", () => {
    const cells = make([cell("sapMListTblSelCol", false), cell("status", true), cell("text", false)]);
    expect(ui5Control({ handle: "row1", op: "click" }).status).toBe("TARGET");
    expect(cells[2]?.hasAttribute("data-sap-mcp-target")).toBe(true);
  });
  test("every cell holds a link: Enter on the row", () => {
    make([cell("status", true), cell("other", true)]);
    expect(ui5Control({ handle: "row1", op: "click" }).status).toBe("FOCUSENTER");
  });
});

describe("FIORI-04: the guard around a draft", () => {
  const V4 = "my.app::OrderObjectPage--fe::";
  const lost = { dialog: { type: "sap.m.MessageBox", title: "Warning", text: "Warning Your entries will be lost when you leave this page. Leave Page Cancel" } };
  const TABLE: [string, ControlFacts, "read" | "navigate" | "commit", string][] = [
    ["the message button", { type: "sap.fe.macros.messages.MessageButton", id: `${V4}FooterBar::MessageButton`, text: "1", buttonType: "Negative", inFooter: true }, "read", "message list"],
    ["V2 message button", button("2", { id: "my.app::ObjectPage--showMessages", inFooter: true }), "read", "message list"],
    ["an entry of the message list", { type: "sap.m.MessageListItem", id: "__item7", text: "Enter a date", dialog: { type: "sap.m.ResponsivePopover", title: "", text: "" } }, "read", "message list"],
    ["table settings (MDC)", { type: "sap.m.OverflowToolbarButton", id: `${V4}table::Items::LineItem-settings`, text: "Settings", icon: "action-settings" }, "read", "value help, filter or search (id)"],
    ["Discard, by its text", button("Discard", { id: "__button118", dialog: { type: "sap.m.Popover", title: "", text: "Discard all changes? Discard" } }), "navigate", "discards a draft"],
    [
      "the button of the popover the Cancel action opened, in any language",
      button("Rejeter", { id: "__button118", dialog: { type: "sap.m.Popover", title: "", text: "Rejeter toutes les modifications ?", openedBy: `${V4}FooterBar::StandardAction::Cancel` } }),
      "navigate",
      "discards a draft",
    ],
    ["Leave Page", button("Leave Page", { id: "__mbox-btn-0", buttonType: "Emphasized", ...lost }), "navigate", "leaves the page, unsaved input is lost"],
    ["a menu button only opens its menu", { type: "sap.m.MenuButton", id: `${V4}CustomAction::BillingBlock`, text: "Billing Block", menuOnly: true }, "navigate", "button that only opens its menu"],
    // still held
    ["a split menu button runs its action", { type: "sap.m.MenuButton", id: `${V4}CustomAction::BillingBlock`, text: "Billing Block", menuOnly: false }, "commit", "text says it writes"],
    ["footer Save", button("Save", { id: `${V4}FooterBar::StandardAction::Save`, buttonType: "Emphasized", inFooter: true }), "commit", "standard action that writes (id)"],
    ["V2 activate", button("Save", { id: "my.app::ObjectPage--activate", inFooter: true }), "commit", "standard action that writes (id)"],
    ["table Delete", button("Delete", { id: `${V4}table::Items::LineItem::StandardAction::Delete` }), "commit", "standard action that writes (id)"],
    ["Post", button("Post", { buttonType: "Emphasized", inFooter: true }), "commit", "text says it writes"],
    ["Save on a question that says input will be lost", button("Save", lost), "commit", "text says it writes"],
    [
      "OK on a question that offers to save",
      button("OK", { dialog: { type: "sap.m.Dialog", title: "Warning", text: "Your entries will be lost. Save Keep Draft Discard Draft" } }),
      "commit",
      "agrees to a dialog that writes",
    ],
    ["Delete in a dialog, though its text is on the discard list's side", button("Discard and Delete", { dialog: { type: "sap.m.Dialog", title: "", text: "" } }), "commit", "text says it writes"],
    ["Delete in a popover that Cancel did not open", button("Delete", { dialog: { type: "sap.m.Popover", title: "", text: "Delete this item?", openedBy: `${V4}table::Items::LineItem::StandardAction::Delete` } }), "commit", "text says it writes"],
    ["an unknown button in a popover that Delete opened", button("Proceed", { dialog: { type: "sap.m.Popover", title: "", text: "Sure?", openedBy: `${V4}table::Items::LineItem::StandardAction::Delete` } }), "commit", "button that is not known to be safe"],
  ];
  for (const [name, facts, risk, rule] of TABLE)
    test(name, () => {
      expect(assessControl(facts, EN)).toMatchObject({ risk, rule });
    });
  test("with writes off: out of the draft and to the errors, not to Save", () => {
    const off = policyFromEnv({});
    const run = (f: ControlFacts) => decide(off, { do: "press", id: f.id }, assessAction({ do: "press", id: f.id }, f, EN)).run;
    expect(run(TABLE[0]?.[1] as ControlFacts)).toBe(true);
    expect(run(TABLE[4]?.[1] as ControlFacts)).toBe(true);
    expect(run(TABLE[6]?.[1] as ControlFacts)).toBe(true);
    expect(run(TABLE[9]?.[1] as ControlFacts)).toBe(false);
  });
  test("the facts say what opened a popover, and that a menu button only opens", () => {
    const cancel = new FakeControl({ type: "sap.m.Button", id: "app::Obj--fe::FooterBar::StandardAction::Cancel", isA: ["sap.m.Button"], props: { text: "Cancel" } });
    const popover = new FakeControl({ type: "sap.m.Popover", id: "__popover5", isA: ["sap.m.Popover"] });
    popover._oOpenBy = cancel;
    const discard = new FakeControl({ type: "sap.m.Button", id: "__button9", isA: ["sap.m.Button"], props: { text: "Verwerfen" }, parent: popover });
    const menu = new FakeControl({ type: "sap.m.MenuButton", id: "app::Obj--Block", isA: ["sap.m.MenuButton"], props: { text: "Billing Block", buttonMode: "Regular" } });
    const inner = new FakeControl({ type: "sap.m.Button", id: "app::Obj--Block-internalBtn", isA: ["sap.m.Button"], props: { text: "Billing Block" }, parent: menu });
    installPage([cancel, popover, discard, menu, inner]);
    expect(ui5Control({ handle: "__button9", op: "facts" }).facts?.dialog?.openedBy).toBe("app::Obj--fe::FooterBar::StandardAction::Cancel");
    expect(ui5Control({ handle: "Block", op: "facts" }).facts?.menuOnly).toBe(true);
    expect(ui5Control({ handle: "Block-internalBtn", op: "facts" }).facts?.menuOnly).toBe(true);
    // the menu button is one line in the compact view
    expect(ui5Look({ compact: true })).not.toContain("internalBtn");
  });
});

describe("FIORI-03: opening an app, and the launchpad's own entries", () => {
  test("an intent, with or without #, with parameters; never a URL", () => {
    expect(intentOf("#SalesOrder-manage")).toBe("#SalesOrder-manage");
    expect(intentOf("SalesOrder-manage")).toBe("#SalesOrder-manage");
    expect(intentOf(" #SalesOrder-display?SalesOrder=4711&/Items/10 ")).toBe("#SalesOrder-display?SalesOrder=4711&/Items/10");
    for (const bad of ["https://evil.example/#SalesOrder-manage", "//evil.example", "javascript:alert(1)", "#", "SalesOrder", "#Sales Order-manage", "#A-b?x=//evil.example", 7, undefined]) expect(intentOf(bad)).toBeUndefined();
  });
  test("opening is navigation; an intent that carries a function code is a write", () => {
    expect(assessAction({ do: "open", app: "#SalesOrder-manage" }, undefined)).toMatchObject({ risk: "navigate", reason: "open #SalesOrder-manage" });
    expect(assessAction({ do: "open", app: "#Shell-startGUI?sap-ui2-tcode=VA02&DYNP_OKCODE=SICH" }, undefined).risk).toBe("commit");
    expect(assessAction({ do: "open", app: "#Shell-startGUI?sap-ui2-tcode=*VA02%20VBAK-VBELN=1" }, undefined).risk).toBe("commit");
  });
  test("the action's shape: open needs app", () => {
    expect(normalizeAction({ do: "open", app: " #SalesOrder-manage " })).toMatchObject({ do: "open", app: "#SalesOrder-manage" });
    expect(() => normalizeAction({ do: "open" })).toThrow(ActionError);
    expect(() => normalizeAction({ do: "open", app: 5 })).toThrow('open needs "app"');
  });
  test("the transaction lists are checked against the intent before it opens", () => {
    const a = { do: "open", app: "#SalesOrder-manage?x=1" };
    const nav = assessAction(a, undefined);
    expect(decide(policyFromEnv({}), a, nav)).toEqual({ run: true });
    expect(decide(policyFromEnv({ SAP_BLOCK_TCODES: "SalesOrder-manage" }), a, nav)).toMatchObject({ run: false, refused: expect.stringContaining("SALESORDER-MANAGE is blocked") });
    expect(decide(policyFromEnv({ SAP_ALLOW_TCODES: "SalesOrder-display" }), a, nav)).toMatchObject({ run: false });
    expect(decide(policyFromEnv({ SAP_ALLOW_TCODES: "SalesOrder-display,SalesOrder-manage" }), a, nav)).toEqual({ run: true });
  });
  const WC = "sap.ushell.gen.ui5.webcomponents-fiori.dist.UserMenuItem";
  const SHELL: [string, ControlFacts, "navigate" | "commit"][] = [
    ["user menu: App Finder", { type: WC, id: "sapUshellUserActionsMenuPopover-3-openCatalogBtn", text: "App Finder" }, "navigate"],
    ["user menu: Settings", { type: WC, id: "sapUshellUserActionsMenuPopover-0-userSettingsBtn", text: "Settings" }, "navigate"],
    ["user menu: About", { type: WC, id: "sapUshellUserActionsMenuPopover-7-aboutBtn", text: "About" }, "navigate"],
    ["side menu", { type: "sap.ushell.gen.ui5.webcomponents.dist.Button", id: "sideMenuExpandCollapseBtn", text: "Open Menu" }, "navigate"],
    ["shell search", { type: "sap.ushell.ShellBarButton", id: "shellbar:toggle-search", text: "Open Search" }, "navigate"],
    ["notifications", { type: "sap.ushell.ShellBarButton", id: "shellbar:notifications", text: "0 Notifications" }, "navigate"],
    ["App Finder tile", { type: "sap.ushell.ui.appfinder.AppBoxInternal", id: "__internal0-x", text: "Manage Sales Orders", handlers: ["onPress"] }, "navigate"],
    // not known: held
    ["user menu: an entry a plugin added", { type: WC, id: "sapUshellUserActionsMenuPopover-5-homeApp-component-s4MyHomeAdaptUIBtn", text: "Adapt UI" }, "commit"],
    ["a custom shell bar button", { type: "sap.ushell.ShellBarButton", id: "shellbar:co-pilot", text: "Assistant" }, "commit"],
  ];
  for (const [name, facts, risk] of SHELL) test(name, () => expect(assessAction({ do: "press", id: facts.id }, facts, EN).risk).toBe(risk));
  test("Sign Out stays its own refusal, whatever its id", () => {
    const a = assessAction({ do: "press", id: "x" }, { type: WC, id: "sapUshellUserActionsMenuPopover-8-logoutBtn", text: "Sign Out" }, EN);
    expect(a).toMatchObject({ risk: "commit", closes: true });
    // even under an id of the safe list
    expect(assessAction({ do: "press", id: "x" }, { type: WC, id: "sapUshellUserActionsMenuPopover-8-aboutBtn", text: "Sign Out" }, EN)).toMatchObject({ risk: "commit", closes: true });
  });
});

describe("FIORI-05: filter values in the view, and keys on them", () => {
  test("a date range shows what its input holds; tokens folded away are named; a stale table says so", () => {
    const range = new FakeControl({ type: "sap.m.DynamicDateRange", id: "app::List--DocDate-inner", isA: ["sap.m.DynamicDateRange"], props: { enabled: true } });
    (range.dom as FakeEl).querySelector = ((sel: string) => (sel === "input" ? Object.assign(new FakeEl("i", "input"), { value: "04/01/2026 - 04/30/2026", type: "text" }) : null)) as never;
    const shown = new FakeControl({ type: "sap.m.Token", id: "app::List--tok0", props: { text: "=6499" } });
    const folded = new FakeControl({ type: "sap.m.Token", id: "app::List--tok1", props: { text: "6490...6495" }, hidden: true });
    const multi = new FakeControl({ type: "sap.ui.mdc.field.FieldMultiInput", id: "app::List--SalesOrder-inner", isA: ["sap.m.MultiInput", "sap.m.InputBase"], props: { editable: true }, methods: { getTokens: () => [shown, folded] } });
    const table = new FakeControl({ type: "sap.m.Table", id: "app::List--table", isA: ["sap.m.Table"], methods: { getShowOverlay: () => true, getColumns: () => [] } });
    installPage([range, multi, shown, folded, table]);
    const view = ui5Look({ compact: true });
    expect(view).toContain('DynamicDateRange #DocDate-inner "04/01/2026 - 04/30/2026"');
    expect(view).toContain('#SalesOrder-inner (and 1 token not shown: "6490...6495")');
    expect(view).toContain('Token #tok0 "=6499"');
    expect(view).toMatch(/Table #table .*\(STALE: the filters changed after these rows were read; press Go to read them again\)/);
  });
  test("Delete and Backspace: in a field or on a token they edit input, elsewhere they may delete", () => {
    const token: ControlFacts = { type: "sap.m.Token", id: "t", text: "=6499" };
    const row: ControlFacts = { type: "sap.m.ColumnListItem", id: "r", text: "" };
    expect(assessAction({ do: "key", key: "Delete" }, undefined, { ...EN, focused: token }).risk).toBe("navigate");
    expect(assessAction({ do: "key", key: "Backspace" }, undefined, { ...EN, focused: { type: "sap.m.Input", id: "i", text: "" } }).risk).toBe("navigate");
    expect(assessAction({ do: "key", key: "Delete" }, undefined, { ...EN, focused: row })).toMatchObject({ risk: "commit", reason: expect.stringContaining("may delete what is selected") });
    expect(assessAction({ do: "key", key: "Delete" }, undefined, EN).risk).toBe("commit");
  });
});

describe("FIORI-08, FIORI-09, FIORI-10", () => {
  test("combo without a key lists the entries and chooses nothing", () => {
    const items = [item("A", "Alpha"), item("B", "Beta")];
    const select = new FakeControl({ type: "sap.m.Select", id: "app::Obj--Status", isA: ["sap.m.Select"], props: { enabled: true, editable: true }, methods: { getItems: () => items, getSelectedItem: () => items[0] } });
    installPage([select]);
    const r = ui5Control({ handle: "Status", op: "combo" });
    expect(r).toMatchObject({ status: "DONE", note: expect.stringContaining("nothing chosen. Entries (key:text): A:Alpha, B:Beta") });
    expect(select.fired).toEqual([]);
  });
  test("look with an id reads that control and what is inside it", () => {
    const form = new FakeControl({ type: "sap.m.Panel", id: "app::Obj--form", props: { headerText: "x" } });
    const inside = new FakeControl({ type: "sap.m.Title", id: "app::Obj--inside", props: { text: "Inside" }, parent: form });
    const outside = new FakeControl({ type: "sap.m.Title", id: "app::Obj--outside", props: { text: "Outside" } });
    (form.dom as FakeEl).querySelectorAll = ((sel: string) => (sel === "[data-sap-ui]" ? [inside.dom] : [])) as never;
    installPage([form, inside, outside]);
    const view = ui5Look({ compact: true, id: "#form" });
    expect(view).toContain("Inside");
    expect(view).not.toContain("Outside");
    expect(ui5Look({ compact: true, id: "nope" })).toBe("");
  });
  test("the page line leaves out the launchpad's state keys", () => {
    installPage([], { title: "Orders", hash: "#SalesOrder-manage&/?sap-iapp-state=TAS79M8LHPAH&x=1" });
    expect(ui5Look({ compact: true }).split("\n")[0]).toBe("PAGE Orders (#SalesOrder-manage&/?x=1)");
    installPage([], { title: "Orders", hash: "#SalesOrder-manage&/Order('1')?sap-iapp-state=TAS79M8LHPAH" });
    expect(ui5Look({ compact: true }).split("\n")[0]).toBe("PAGE Orders (#SalesOrder-manage&/Order('1'))");
  });
  test("fields of one object name its context once", () => {
    const ctx = { getPath: () => "/Order('1')" };
    const field = (n: string) => new FakeControl({ type: "sap.m.Input", id: `app::Obj--${n}`, isA: ["sap.m.InputBase"], props: { value: n, editable: true }, methods: { getBindingContext: () => ctx } });
    installPage([field("a"), field("b")]);
    const lines = ui5Look({ compact: true }).split("\n");
    expect(lines).toContain(`Input #a "a" {ctx:/Order('1')}`);
    expect(lines).toContain('Input #b "b"');
  });
  test("compact: a context without the draft id and the active flag every active document has", () => {
    const ctx = { getPath: () => "/C_Order(Order='1',DraftUUID=guid'00000000-0000-0000-0000-000000000000',IsActiveEntity=true)" };
    const draft = { getPath: () => "/C_Order(Order='',DraftUUID=guid'0a1b2c3d-0000-0000-0000-000000000001',IsActiveEntity=false)" };
    const field = (n: string, c: typeof ctx) => new FakeControl({ type: "sap.m.Input", id: `app::Obj--${n}`, isA: ["sap.m.InputBase"], props: { value: n, editable: true }, methods: { getBindingContext: () => c } });
    installPage([field("a", ctx), field("d", draft)]);
    const view = ui5Look({ compact: true });
    expect(view).toContain(`Input #a "a" {ctx:/C_Order(Order='1')}`);
    expect(view).toContain("DraftUUID=guid'0a1b2c3d-0000-0000-0000-000000000001',IsActiveEntity=false");
    expect(ui5Look({ compact: false })).toContain("IsActiveEntity=true");
  });
});

export { marked };
