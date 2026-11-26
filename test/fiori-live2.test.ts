/**
 * Fiori findings of the live test of 2026-11-23 (S/4 2025, purchase and sales orders): drafts, grid-table
 * rows that open through their row action, an error's details, rows and columns of a table read alone,
 * one line per smart field and per row, section tabs behind the overflow, and the answers built from the
 * views (diffs on one page, a popup without the page behind it). Synthetic pages for the reader; the
 * views of the answers are the live ones (test/fixtures/fiori-live, NNN = the call of that test).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { idOn } from "../src/batch.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import { diffViews, whereLine } from "../src/core/diff.js";
import { fioriPopupFirst, Views } from "../src/core/views.js";
import { leftDraftNote } from "../src/fiori/driver.js";
import { assessAction } from "../src/fiori/risk.js";
import { ui5Control, ui5Draft, ui5Look } from "../src/fiori/ui5.js";
import { FakeControl, FakeEl, installPage, marked, removePage } from "./fiori-fixtures.js";

afterAll(removePage);

const live = (n: string) => readFileSync(new URL(`./fixtures/fiori-live/${n}.txt`, import.meta.url), "utf8").trimEnd();

/** The page's text as a person sees it: each element's own `texts` (shownText walks them). */
function withTexts(): void {
  const g = globalThis as unknown as { document: { createTreeWalker: (d: FakeEl) => { nextNode: () => unknown } } };
  g.document.createTreeWalker = (d: FakeEl) => {
    const nodes = ((d as unknown as { texts?: string[] }).texts ?? []).map((t) => ({ nodeValue: t, parentElement: d }));
    let i = 0;
    return { nextNode: () => nodes[i++] ?? null };
  };
}
const texts = (c: FakeControl, ...t: string[]) => Object.assign(c.dom as FakeEl, { texts: t });
const inside = (child: FakeControl, parent: FakeControl) => {
  (child.dom as FakeEl).parentElement = parent.dom;
};

describe("F3: an error's View Details", () => {
  test("a formatted text is written as its text without the tags", () => {
    const dialog = new FakeControl({ type: "sap.m.Dialog", id: "__dialog45", props: { title: "Error" } });
    const details = new FakeControl({
      type: "sap.m.FormattedText",
      id: "__text857",
      parent: dialog,
      methods: { getHtmlText: () => "<p>Could not open app &quot;nonexistentApp&quot;.</p><ul><li>Reason: <strong>no target mapping</strong></li></ul>" },
    });
    inside(details, dialog);
    installPage([dialog, details]);
    expect(ui5Look({ compact: true })).toContain('FormattedText #__text857 "Could not open app "nonexistentApp". - Reason: no target mapping"');
  });
});

describe("F6: a smart field in display mode is one line", () => {
  test("its text, key, amount and unit on the field's line; its parts have none", () => {
    const sf = new FakeControl({ type: "sap.ui.comp.smartfield.SmartField", id: "po::Details--Supplier::Field", props: { value: "17300001" } });
    const txt = new FakeControl({ type: "sap.m.Text", id: "po::Details--Supplier::Field-text", props: { text: "Domestic US Supplier 1 (17300001)" }, parent: sf });
    inside(txt, sf);
    const label = new FakeControl({ type: "sap.m.Label", id: "po::Details--Supplier::Field-label", isA: ["sap.m.Label"], props: { text: "Supplier" }, methods: { getLabelFor: () => "po::Details--Supplier::Field" } });
    const amount = new FakeControl({ type: "sap.ui.comp.smartfield.SmartField", id: "po::Details--NetAmount::Field", props: { value: "420.00" } });
    const unit = new FakeControl({ type: "sap.ui.comp.smartfield.SmartField", id: "po::Details--NetAmount::Field-sfDisp", props: { value: "USD" }, parent: amount });
    inside(unit, amount);
    installPage([label, sf, txt, amount, unit]);
    withTexts();
    texts(sf, "Domestic US Supplier 1 (17300001)");
    texts(amount, "420.00", "USD");
    const view = ui5Look({ compact: true });
    expect(view).toContain('smartfield.SmartField #Supplier::Field "Supplier": "Domestic US Supplier 1 (17300001)"');
    expect(view).toContain('smartfield.SmartField #NetAmount::Field "420.00 USD"');
    expect(view).not.toContain("Field-text");
    expect(view).not.toContain("sfDisp");
  });
  test("a binding path alone is not written; a row's or field's context is", () => {
    const filter = new FakeControl({
      type: "sap.ui.comp.smartfilterbar.SFBMultiInput",
      id: "lr--listReportFilter-filterItemControl_BASIC-Supplier",
      isA: ["sap.m.InputBase"],
      props: { value: "" },
      methods: { getBindingInfo: ((p: string) => (p === "value" ? { parts: [{ path: "/Supplier/value", model: "fi1t3rM0d31" }] } : undefined)) as never },
    });
    installPage([filter]);
    expect(ui5Look({ compact: true })).not.toContain("fi1t3rM0d31");
    expect(ui5Look({ compact: false })).toContain("fi1t3rM0d31");
  });
});

/** A responsive table: columns (one hidden), rows of cells with texts. */
function responsive(rowsN = 3) {
  const col = (title: string, visible = true) => ({ getVisible: () => visible, getHeader: () => ({ getText: () => title }) });
  const columns = [col("Sales Order"), col("Hidden", false), col("Net Value"), col("Status")];
  const items: FakeControl[] = [];
  const table = new FakeControl({
    type: "sap.m.Table",
    id: "so::List--LineItem-innerTable",
    isA: ["sap.m.Table"],
    methods: { getColumns: () => columns, getItems: () => items, getBinding: ((n: string) => (n === "items" ? { getLength: () => 7090 } : undefined)) as never },
  });
  for (let i = 0; i < rowsN; i++) {
    const cells = [`${7708 - i}`, "x", `${35 + i}.10 USD`, i ? "Completed" : "Open"].map((t) => ({ getDomRef: () => new FakeEl(`c${i}${t}`), getText: () => t }));
    items.push(new FakeControl({ type: "sap.m.ColumnListItem", id: `so::List--LineItem-innerTableRow-__clone${105 + i}`, isA: ["sap.m.ListItemBase"], parent: table, methods: { getCells: () => cells, getType: () => "Navigation" } }));
  }
  return { table, items };
}

describe("F4/F5: table rows", () => {
  test("a row has one cell per column the header shows: a hidden column's cell is not one (live: 11 cells under 10 titles)", () => {
    const { table, items } = responsive();
    installPage([table, ...items]);
    const view = ui5Look({ compact: true });
    expect(view).toContain("columns: Sales Order | Net Value | Status");
    expect(view).toContain("row: 7708 | 35.10 USD | Open  (press a row to open it; its links: sap_look with the row's id)");
    expect(view).toContain("row: 7707 | 36.10 USD | Completed");
  });
  test("a pop-in's label and text and a row's links have no line of their own; read alone, the row lists its links", () => {
    const { table, items } = responsive(1);
    const row = items[0] as FakeControl;
    const rowEl = row.dom as FakeEl;
    rowEl.closest = ((sel: string) => (sel.includes("sapMListTblRow") ? rowEl : null)) as never;
    const link = new FakeControl({ type: "sap.m.Link", id: "__identifier1-__clone98-__clone105-link", isA: ["sap.m.Link"], props: { text: "7708" } });
    const sub = new FakeEl("sub");
    sub.closest = ((sel: string) => (sel.includes("sapMListTblSubRow") ? sub : null)) as never;
    const popLabel = new FakeControl({ type: "sap.m.Label", id: "__label29-__clone135", isA: ["sap.m.Label"], props: { text: "Document Date" } });
    const popText = new FakeControl({ type: "sap.m.Text", id: "__text126-__clone104-__clone105", props: { text: "11/23/2026" } });
    (link.dom as FakeEl).parentElement = rowEl;
    (popLabel.dom as FakeEl).parentElement = sub;
    (popText.dom as FakeEl).parentElement = sub;
    installPage([table, row, link, popLabel, popText]);
    const view = ui5Look({ compact: true });
    expect(view).not.toContain("__identifier1");
    expect(view).not.toContain("Document Date");
    expect(view).not.toContain('"11/23/2026"');
    // Read alone (its id): the link has a line.
    (globalThis as unknown as { document: { querySelectorAll: unknown } }).document.querySelectorAll = (sel: string) => (sel === "[data-sap-ui]" ? [rowEl, link.dom] : []);
    rowEl.querySelectorAll = (() => [link.dom]) as never;
    expect(ui5Look({ compact: true, id: "LineItem-innerTableRow-__clone105" })).toContain('Link #__identifier1-__clone98-__clone105-link "7708"');
  });
  test("read alone with rows and cols: the rows asked for, the columns by title, one line each (live #41: 16.6 KB, rows ignored)", () => {
    const { table, items } = responsive(30);
    installPage([table, ...items]);
    const out = ui5Look({ compact: true, id: "LineItem-innerTable", rows: { from: 25, to: 27 }, cols: ["Sales Order", "net value"] });
    const lines = out.split("\n");
    expect(lines[1]).toBe("Table #LineItem-innerTable columns: Sales Order | Net Value (7090 rows, 30 loaded; rows 25-27 here)");
    expect(lines.slice(2)).toEqual(["  row 25 #LineItem-innerTableRow-__clone130: 7683 | 60.10 USD", "  row 26 #LineItem-innerTableRow-__clone131: 7682 | 61.10 USD", "  row 27 #LineItem-innerTableRow-__clone132: 7681 | 62.10 USD"]);
    expect(out.length).toBeLessThan(400);
  });
  test("rows beyond the loaded ones and an unknown column: said first, with how to load more", () => {
    const { table, items } = responsive(30);
    installPage([table, ...items]);
    const out = ui5Look({ compact: true, id: "LineItem-innerTable", rows: { from: 28, to: 40 }, cols: ["Sales Order", "Customer"] });
    const lines = out.split("\n");
    expect(lines[1]).toStartWith('NOTE no column "customer"; the columns are: Sales Order | Net Value | Status.');
    expect(lines[2]).toStartWith("NOTE rows 28-40: the page has loaded rows 0-29 of 7090; to load more, scroll to the end of the list");
    expect(lines.filter((l) => l.startsWith("  row "))).toHaveLength(2);
  });
});

/** A grid table (sap.ui.table) row with a row action whose item navigates. */
function gridWithRowAction() {
  const pressed: string[] = [];
  const nav = { getVisible: () => true, getType: () => "Navigation", getText: () => "Details", firePress: () => pressed.push("api") };
  const rows: FakeControl[] = [];
  const table = new FakeControl({
    type: "sap.ui.table.Table",
    id: "po::Details--ItemsFacet::gridTable",
    isA: ["sap.ui.table.Table"],
    methods: { getRows: () => rows, getColumns: () => [{ getVisible: () => true, getLabel: () => ({ getText: () => "Item" }) }], getSelectionMode: () => "MultiToggle", getSelectionBehavior: () => "RowSelector" },
  });
  const rowAction = new FakeControl({ type: "sap.ui.table.RowAction", id: "po::Details--ItemsFacet::rowAction-__clone1026", methods: { getItems: () => [nav] } });
  const icon = new FakeControl({ type: "sap.ui.core.Icon", id: "po::Details--ItemsFacet::rowAction-__clone1026-icon0" });
  const sel = new FakeControl({ type: "sap.m.Text", id: "po::Details--ItemsFacet::gridTable-rowsel0" });
  const row = new FakeControl({
    type: "sap.ui.table.Row",
    id: "po::Details--ItemsFacet::gridTable-rows-row0",
    isA: ["sap.ui.table.Row"],
    parent: table,
    methods: { getIndex: () => 0, getBindingContext: () => ({}), getAggregation: ((n: string) => (n === "_rowAction" ? rowAction : null)) as never, getCells: () => [{ getDomRef: () => new FakeEl("cell"), getText: () => "10" }] },
  });
  rows.push(row);
  return { controls: [table, row, rowAction, icon, sel], pressed };
}

describe("F2: a grid-table row opens through its row action", () => {
  test("press marks the row's navigation arrow, select still ticks the row, the view says so", () => {
    const { controls } = gridWithRowAction();
    installPage(controls);
    const r = ui5Control({ handle: "ItemsFacet::gridTable-rows-row0", op: "click" });
    expect(r.status).toBe("TARGET");
    expect(r.note).toContain('its navigation ("Details")');
    expect(marked(controls)).toBe("po::Details--ItemsFacet::rowAction-__clone1026-icon0");
    ui5Control({ handle: "ItemsFacet::gridTable-rows-row0", op: "select" });
    expect(marked(controls)).toBe("po::Details--ItemsFacet::gridTable-rowsel0");
    expect(ui5Control({ handle: "ItemsFacet::gridTable-rows-row0", op: "dblclick" }).single).toBe(true);
    expect(ui5Look({ compact: true })).toContain("row: [ ] 10  (press a row to open it; select ticks it)");
  });
  test("an arrow that is not drawn: the row action's own press", () => {
    const { controls, pressed } = gridWithRowAction();
    controls[3] = new FakeControl({ type: "sap.ui.core.Icon", id: "other", hidden: true });
    installPage(controls);
    expect(ui5Control({ handle: "ItemsFacet::gridTable-rows-row0", op: "click" }).status).toBe("DONE");
    expect(pressed).toEqual(["api"]);
  });
  test("a press on the row is a navigation for the guard", () => {
    expect(assessAction({ do: "press", id: "r" }, { type: "sap.ui.table.Row", id: "r", text: "" }).risk).toBe("navigate");
  });
});

/** An object page with two sections; the second one's tab is in the overflow. */
function objectPage() {
  const calls: string[] = [];
  let selected = "po::Item--General::Section";
  const opl: FakeControl = new FakeControl({
    type: "sap.uxap.ObjectPageLayout",
    id: "po::Item--objectPage",
    methods: {
      getAggregation: ((n: string) => (n === "_anchorBar" ? bar : null)) as never,
      getSelectedSection: () => selected,
      setSelectedSection: ((s: FakeControl) => {
        selected = s.getId();
        calls.push(`select ${s.getId()}`);
      }) as never,
      scrollToSection: ((id: string) => calls.push(`scroll ${id}`)) as never,
    },
  });
  const barControl = new FakeControl({ type: "sap.m.IconTabHeader", id: "po::Item--objectPage-anchBar", parent: opl });
  const section = (key: string, title: string) => new FakeControl({ type: "sap.uxap.ObjectPageSection", id: `po::Item--${key}::Section`, isA: ["sap.uxap.ObjectPageSectionBase"], props: { title }, parent: opl });
  const general = section("General", "General Information");
  const flow = section("ProcessFlow", "Process Flow");
  const anchor = (s: FakeControl, hidden = false) =>
    new FakeControl({ type: "sap.m.IconTabFilter", id: `po::Item--objectPage-anchBar-${s.getId()}-anchor`, isA: ["sap.m.IconTabFilter"], props: { text: String(s.props.title) }, parent: barControl, hidden, methods: { getKey: () => s.getId() } });
  const anchors = [anchor(general), anchor(flow, true)];
  const bar = { getItems: () => anchors };
  return { controls: [opl, barControl, ...anchors, general, flow], calls };
}

describe("F8: object-page sections", () => {
  test("all section titles on one line, also those behind the overflow; no line per tab", () => {
    const { controls } = objectPage();
    installPage(controls);
    const view = ui5Look({ compact: true });
    expect(view).toContain('SECTIONS General Information (selected) | Process Flow  (select one by its title: {"do":"select","id":"Process Flow"})');
    expect(view).not.toContain("IconTabFilter");
  });
  test("select by title or by the tab's id goes through the layout, not a click", () => {
    const { controls, calls } = objectPage();
    installPage(controls);
    const facts = ui5Control({ handle: "Process Flow", op: "facts" }).facts;
    expect(facts?.type).toBe("sap.uxap.ObjectPageSection");
    expect(assessAction({ do: "select", id: "Process Flow" }, facts).risk).toBe("navigate");
    expect(ui5Control({ handle: "Process Flow", op: "select" })).toMatchObject({ status: "DONE", note: 'section "Process Flow" of the object page' });
    expect(calls).toEqual(["select po::Item--ProcessFlow::Section", "scroll po::Item--ProcessFlow::Section"]);
    // The tab sits in the overflow (not drawn): still selected (live #26: "covered, hidden or not ready").
    expect(ui5Control({ handle: "ProcessFlow::Section-anchor", op: "select" }).status).toBe("DONE");
    expect(marked(controls)).toBeUndefined();
  });
});

describe("F1: drafts", () => {
  const draftHash = "#PurchaseOrder-manage&/C_PurchaseOrderTP(PurchaseOrder='4500000509',DraftUUID=guid'42010aa4-0003-1fd1-b9ea-33363d77a000')";
  test("a draft page says so on the view, with its Discard Draft button", () => {
    const discard = new FakeControl({ type: "sap.m.Button", id: "po::Details--discard", isA: ["sap.m.Button"], props: { text: "Discard Draft" } });
    installPage([discard], { title: "Purchase Order", hash: draftHash });
    const view = ui5Look({ compact: true }).split("\n");
    expect(view[1]).toStartWith('DRAFT this page is a draft, kept on the server: it locks the document for other users. Leaving the page keeps it; "Discard Draft" (#discard) deletes it');
    expect(ui5Draft()).toEqual({ title: "Purchase Order", hash: draftHash });
  });
  test("an active document is no draft", () => {
    installPage([new FakeControl({ type: "sap.m.Button", id: "po::Details--edit", props: { text: "Edit" } })], { hash: "#PurchaseOrder-manage&/C_PurchaseOrderTP(PurchaseOrder='4500000509',DraftUUID=guid'00000000-0000-0000-0000-000000000000')" });
    expect(ui5Look({ compact: true })).not.toContain("DRAFT");
    expect(ui5Draft()).toBeNull();
  });
  test("leaving a draft: the answer says the draft stays; staying on it says nothing", () => {
    const d = { title: "Purchase Order", hash: draftHash };
    expect(leftDraftNote(d, null)).toContain("the page you left was a draft");
    expect(leftDraftNote(d, d)).toBe("");
    expect(leftDraftNote(null, null)).toBe("");
  });
  test("Edit is refused with writes off", () => {
    const a = assessAction({ do: "press", id: "C_PurchaseOrderItemTP--edit" }, { type: "sap.uxap.ObjectPageHeaderActionButton", id: "x::C_PurchaseOrderItemTP--edit", text: "Edit" });
    expect(decide(policyFromEnv({ SAP_WRITE: "off" }), { do: "press", id: "C_PurchaseOrderItemTP--edit" }, a).run).toBe(false);
  });
});

describe("F7: answers on one page are its changes; a popup comes without the page behind it", () => {
  test("a section tab on the same object page: the changes, with what left the view on one line (live #20: 6.5 KB)", () => {
    const views = new Views();
    views.present("s", live("019"), true);
    const answer = views.present("s", live("020"));
    expect(answer).toStartWith('CHANGED 45 of 73 lines on "4500000509 (Standard PO) - Purchase Order" (same screen');
    expect(answer).toContain('~ IconTabFilter #ItemsFacet::Section-anchor "Items" (selected)');
    expect(answer).toMatch(/^- \d+ lines left the view \(scrolled away or closed\): #/m);
    expect(answer.length).toBeLessThan(live("020").length * 0.4);
  });
  test("another page is the whole view", () => {
    const views = new Views();
    views.present("s", live("040"), true);
    expect(views.present("s", live("019"))).toBe(live("019"));
  });
  test("a popup: the popup whole, the page behind it one line (live #33 9.7 KB, #15 4.4 KB)", () => {
    for (const n of ["033", "015"]) {
      const views = new Views();
      views.present("s", live("040"), true);
      const answer = views.present("s", live(n));
      expect(answer).toContain("POPUP ");
      expect(answer).toMatch(/^\(the page behind the popup: \d+ lines, not repeated here/m);
      expect(answer).not.toContain("ShellBarButton");
      expect(answer.length).toBeLessThan(live(n).length * 0.4);
    }
    // Asked for whole (sap_look), it stays whole.
    expect(new Views().present("s", live("033"), true)).toBe(live("033"));
  });
  test("the popup closed: the changes since the page before it", () => {
    const views = new Views();
    views.present("s", live("040"), true);
    views.present("s", live("015"));
    const answer = views.present("s", live("040"));
    expect(answer).toStartWith("NO CHANGE on");
    expect(answer).toContain('back from the popup');
  });
  test("where a Fiori view is: the page's title and the popup's", () => {
    expect(whereLine(live("033"))).toBe('"Manage Sales Orders - Version 2" · popup "Sold-to Party"');
    expect(diffViews(live("040"), live("040")).text).toStartWith('NO CHANGE on "Manage Sales Orders - Version 2"');
  });
  test("fioriPopupFirst leaves a view without a popup as it is", () => {
    expect(fioriPopupFirst(live("040"))).toBe(live("040"));
  });
});

describe("Batch: an id of a Fiori view, sent without #", () => {
  test("after a tile press the next step's id is on the new app (live #48)", () => {
    const v = live("048");
    expect(idOn(v, "SalesOrder-inner")).toBe(true);
    expect(idOn(v, "#SalesOrder-inner")).toBe(true);
    expect(idOn(v, "SalesOrderManage-btnSearch")).toBe(true);
    // The full id, or a longer tail of it, names the same control (the driver finds it by any tail).
    expect(idOn(v, "cus.sd.salesorderv2.manage::SalesOrderManageList--fe::FilterBar::SalesOrderManage::FilterField::SalesOrder-inner")).toBe(true);
    expect(idOn(v, "Supplier-inner")).toBe(false);
    expect(idOn(v, "Order-inner")).toBe(false);
  });
});
