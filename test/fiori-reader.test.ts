import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ui5Control, ui5Look } from "../src/fiori/ui5.js";
import { FakeControl, installPage, item, marked, removePage } from "./fiori-fixtures.js";

const VIEW = "app.demo::ObjectPage--";
let controls: FakeControl[];
let select: FakeControl;

beforeEach(() => {
  const page = new FakeControl({ type: "sap.m.Page", id: `${VIEW}page` });
  const footer = new FakeControl({ type: "sap.m.OverflowToolbar", id: `${VIEW}fe::FooterBar`, parent: page, aggregation: "footer" });
  const items = [item("A", "Alpha"), item("B", "Beta"), item("C", "Gamma Ray")];
  let selected = items[0];
  select = new FakeControl({
    type: "sap.m.Select",
    id: `${VIEW}fe::Field::Status`,
    props: { enabled: true, editable: true },
    methods: {
      getItems: () => items,
      getSelectedItem: () => selected,
      setSelectedItem: ((it: (typeof items)[0]) => {
        selected = it;
      }) as never,
    },
  });
  controls = [
    page,
    new FakeControl({ type: "sap.m.Title", id: `${VIEW}title`, props: { text: "Demo Object 1" } }),
    new FakeControl({ type: "sap.m.Label", id: `${VIEW}fe::Field::Name-label`, isA: ["sap.m.Label"], props: { text: "Name" }, methods: { getLabelFor: () => `${VIEW}fe::Field::Name` } }),
    new FakeControl({ type: "sap.m.Input", id: `${VIEW}fe::Field::Name`, isA: ["sap.m.InputBase"], props: { value: "Widget", editable: true, required: true } }),
    new FakeControl({ type: "sap.m.Input", id: `${VIEW}fe::Field::Secret`, isA: ["sap.m.InputBase"], props: { value: "hunter2", type: "Password" } }),
    new FakeControl({ type: "sap.m.CheckBox", id: `${VIEW}fe::Field::Approved`, props: { text: "Approved", selected: true, enabled: true } }),
    select,
    new FakeControl({ type: "sap.m.Button", id: `${VIEW}fe::Field::Locked`, isA: ["sap.m.Button"], props: { text: "Unlock", enabled: false } }),
    // Two controls whose last id segment is the same: neither short tail is unique.
    new FakeControl({ type: "sap.m.Button", id: "app.demo::List--table::Add", isA: ["sap.m.Button"], props: { text: "Add" } }),
    new FakeControl({ type: "sap.m.Button", id: "app.demo::Other--table::Add", isA: ["sap.m.Button"], props: { text: "Add" }, hidden: true }),
    footer,
    new FakeControl({
      type: "sap.m.Button",
      id: `${VIEW}fe::FooterBar::StandardAction::Save`,
      isA: ["sap.m.Button"],
      props: { text: "Save", type: "Emphasized" },
      parent: footer,
      handlers: { press: ["bound _saveDocument"] },
    }),
  ];
  installPage(controls, { title: "Demo Object", hash: "#Demo-display" });
});
afterAll(removePage);

describe("ui5Look", () => {
  test("compact: one line per control, shortest unique id tail, label on the field's line", () => {
    const lines = ui5Look({ compact: true }).split("\n");
    expect(lines[0]).toBe("PAGE Demo Object (#Demo-display)");
    expect(lines).toContain('Title #title "Demo Object 1"');
    expect(lines).toContain('Input #Name "Name": "Widget" (required)');
    expect(lines).toContain('CheckBox #Approved "Approved" [x] checked');
    expect(lines).toContain('Select #Status = "Alpha"');
    expect(lines).toContain('Button #Locked "Unlock" (disabled)');
    expect(lines).toContain('Button #Save "Save"');
    // the label has no line of its own, the layout-only page neither
    expect(lines.some((l) => l.includes("Name-label"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Page "))).toBe(false);
  });
  test("compact: an id tail shared with another control on screen grows until it is unique", () => {
    // The other "table::Add" is not rendered: the short tail names the one on screen (ui5Control finds it first).
    expect(ui5Look({ compact: true })).toContain('Button #Add "Add"');
    const a = new FakeControl({ type: "sap.m.Button", id: "app.demo::List--table::Add", isA: ["sap.m.Button"], props: { text: "Add" } });
    const b = new FakeControl({ type: "sap.m.Button", id: "app.demo::Other--table::Add", isA: ["sap.m.Button"], props: { text: "Add" } });
    installPage([a, b]);
    expect(ui5Look({ compact: true })).toContain('Button #List--table::Add "Add"');
    expect(ui5Control({ handle: "Add", op: "facts" }).facts?.id).toBe("app.demo::List--table::Add");
  });
  test("a password is never written out", () => {
    for (const compact of [true, false]) {
      const view = ui5Look({ compact });
      expect(view).not.toContain("hunter2");
      expect(view).toContain("***");
    }
  });
  test("full: every control with its type and full id", () => {
    const view = ui5Look({ compact: false });
    expect(view).toContain(`sap.m.Page id=${VIEW}page`);
    expect(view).toContain(`sap.m.Input id=${VIEW}fe::Field::Name "Name": value="Widget" (required)`);
    expect(view).toContain(`sap.m.Label id=${VIEW}fe::Field::Name-label text="Name"`);
  });
});

describe("ui5Control", () => {
  test("finds a control by its compact tail, with or without #, and by its full id", () => {
    for (const handle of ["#Save", "Save", "StandardAction::Save", `${VIEW}fe::FooterBar::StandardAction::Save`]) {
      const r = ui5Control({ handle, op: "click" });
      expect(r.status).toBe("TARGET");
      expect(marked(controls)).toBe(`${VIEW}fe::FooterBar::StandardAction::Save`);
    }
    expect(ui5Control({ handle: "Nope", op: "click" }).status).toBe("NOTFOUND");
  });
  test("an ambiguous tail goes to the control that is on screen", () => {
    expect(ui5Control({ handle: "Add", op: "click" }).status).toBe("TARGET");
    expect(marked(controls)).toBe("app.demo::List--table::Add");
  });
  test("facts for the risk rule: footer, button type, handler names", () => {
    const f = ui5Control({ handle: "Save", op: "facts" }).facts;
    expect(f).toMatchObject({ type: "sap.m.Button", text: "Save", buttonType: "Emphasized", inFooter: true, handlers: ["_saveDocument"] });
    expect(marked(controls)).toBeUndefined();
  });
  test("a dropdown entry is chosen through the control's API, by key or text", () => {
    expect(ui5Control({ handle: "Status", op: "combo", value: "B" })).toMatchObject({ status: "DONE", note: expect.stringContaining('"Beta"') });
    expect(select.fired).toEqual(["change:Beta"]);
    expect(ui5Control({ handle: "Status", op: "combo", value: "gamma" }).status).toBe("DONE");
    expect(ui5Look({ compact: true })).toContain('Select #Status = "Gamma Ray"');
  });
  test("an unknown dropdown entry answers with the entries", () => {
    const r = ui5Control({ handle: "Status", op: "combo", value: "Zeta" });
    expect(r.status).toBe("NOITEM");
    expect(r.note).toContain("A:Alpha, B:Beta, C:Gamma Ray");
  });
  test("check clicks only when the state has to change", () => {
    expect(ui5Control({ handle: "Approved", op: "check", value: true })).toMatchObject({ status: "DONE", note: expect.stringContaining("already checked") });
    expect(ui5Control({ handle: "Approved", op: "check", value: false }).status).toBe("TARGET");
    expect(ui5Control({ handle: "Approved", op: "check" }).status).toBe("TARGET");
    expect(ui5Control({ handle: "Name", op: "check" }).status).toBe("NOTFIT");
  });
  test("a password input is never typed into", () => {
    const r = ui5Control({ handle: "Secret", op: "fill", value: "x" });
    expect(r.status).toBe("NOTFIT");
    expect(r.note).toContain("password field: this server never types a password");
    expect(marked(controls)).toBeUndefined();
    expect(ui5Control({ handle: "Secret", op: "facts" }).facts?.password).toBe(true);
    expect(ui5Control({ handle: "Name", op: "facts" }).facts?.password).toBeUndefined();
  });
  test("fill refuses a button: typing does not press it", () => {
    expect(ui5Control({ handle: "Save", op: "fill", value: " " }).status).toBe("NOTFIT");
    expect(marked(controls)).toBeUndefined();
  });
  test("facts come with the page's language", () => {
    const g = globalThis as unknown as { sap: { ui: { getCore: () => Record<string, unknown> } } };
    const core = g.sap.ui.getCore();
    g.sap.ui.getCore = () => ({ ...core, getConfiguration: () => ({ getLanguage: () => "de-DE" }) });
    expect(ui5Control({ handle: "Save", op: "facts" }).language).toBe("de-DE");
    expect(ui5Control({ handle: "", op: "facts" }).language).toBe("de-DE");
    g.sap.ui.getCore = () => core;
    expect(ui5Control({ handle: "Save", op: "facts" }).language).toBeUndefined();
  });
  test("fill with nothing on a field with tokens removes them (a filter's values), and says which", () => {
    let tokens = [new FakeControl({ type: "sap.m.Token", id: "__token2", props: { text: "=24" } })];
    const fired: string[] = [];
    const multi = new FakeControl({
      type: "sap.m.MultiInput",
      id: `${VIEW}fe::Filter::SalesOrder`,
      isA: ["sap.m.InputBase", "sap.m.MultiInput"],
      props: { value: "", editable: true },
      methods: {
        getTokens: () => tokens,
        removeAllTokens: (() => {
          tokens = [];
        }) as never,
        fireTokenUpdate: ((e: { type: string }) => fired.push(`tokenUpdate:${e.type}`)) as never,
        fireChange: (() => fired.push("change")) as never,
      },
    });
    installPage([...controls, multi], { title: "Demo Object", hash: "#Demo-display" });
    expect(ui5Control({ handle: "SalesOrder", op: "fill", value: "" })).toMatchObject({ status: "DONE", note: expect.stringContaining('removed 1 value ("=24")') });
    expect(tokens).toEqual([]);
    expect(fired).toEqual(["tokenUpdate:removed", "change"]);
    // With no tokens left, or with a value to type, it is typed as before.
    expect(ui5Control({ handle: "SalesOrder", op: "fill", value: "" }).status).toBe("TARGET");
    expect(ui5Control({ handle: "SalesOrder", op: "fill", value: "25" }).status).toBe("TARGET");
  });
  test("fill marks the input; a disabled control is refused", () => {
    expect(ui5Control({ handle: "Name", op: "fill", value: "x" }).status).toBe("TARGET");
    expect(marked(controls)).toBe(`${VIEW}fe::Field::Name`);
    expect(ui5Control({ handle: "Locked", op: "click" }).status).toBe("DISABLED");
    expect(ui5Control({ handle: "Approved", op: "fill", value: "x" }).status).toBe("NOTFIT");
  });
});

describe("ui5Look: the page named as shown, tiles without placeholder numbers", () => {
  test("the launchpad home while the address names an app that did not open (expired logon, live 2026-11-23)", () => {
    installPage([new FakeControl({ type: "sap.m.Title", id: "t", props: { text: "To-Dos" } })], { title: "Home", hash: "#PurchaseOrder-manage" });
    const g = globalThis as unknown as { sap: Record<string, unknown> };
    g.sap.ushell = { Container: { getService: () => ({ getCurrentApplication: () => ({ homePage: true }) }) } };
    expect(ui5Look({ compact: true }).split("\n")[0]).toBe("PAGE Home (#Shell-home, the launchpad home: #PurchaseOrder-manage was asked for and has not opened)");
  });
  test('a tile is its own line: no TileContent, no NumericContent "1234"', () => {
    const tile = new FakeControl({ type: "sap.m.GenericTile", id: "__tile72", isA: ["sap.m.GenericTile"], props: { header: "Manage Sales Orders" }, handlers: { press: ["p"] } });
    const tc = new FakeControl({ type: "sap.m.TileContent", id: "__xmlview14--numericTileContent", isA: ["sap.m.TileContent"], parent: tile, tooltip: "1234" });
    const nc = new FakeControl({ type: "sap.m.NumericContent", id: "__content119", isA: ["sap.m.NumericContent"], parent: tc, props: { value: "1234" }, methods: { getValue: () => "1234" } });
    installPage([tile, tc, nc], { title: "Search", hash: "#Action-search" });
    const v = ui5Look({ compact: true });
    expect(v).toContain("GenericTile #__tile72");
    expect(v).not.toContain("1234");
  });
});

describe("ui5Look: FILTERS, the values a list report's filter bar holds", () => {
  test("a token left from before is named at the top (live 2026-11-23 #34: 0 rows for own drafts)", () => {
    const bar = new FakeControl({ type: "sap.ui.comp.smartfilterbar.SmartFilterBar", id: "listReportFilter", isA: ["sap.ui.comp.filterbar.FilterBar"] });
    const token = { getText: () => "=4500000509" };
    const po = new FakeControl({ type: "sap.ui.comp.smartfilterbar.SFBMultiInput", id: "listReportFilter-filterItemControl_BASIC-PurchaseOrder", isA: ["sap.m.MultiInput", "sap.m.InputBase"], parent: bar, props: { value: "", placeholder: "Purchase Order" }, methods: { getTokens: () => [token], getValue: () => "", getPlaceholder: () => "Purchase Order" } });
    const sup = new FakeControl({ type: "sap.ui.comp.smartfilterbar.SFBMultiInput", id: "listReportFilter-filterItemControl_BASIC-Supplier", isA: ["sap.m.MultiInput", "sap.m.InputBase"], parent: bar, props: { value: "" }, methods: { getTokens: () => [], getValue: () => "" } });
    installPage([bar, po, sup], { title: "Manage Purchase Orders", hash: "#PurchaseOrder-manage&/" });
    const lines = ui5Look({ compact: true }).split("\n");
    expect(lines[1]).toBe('FILTERS Purchase Order "=4500000509"  (set in the filter bar, maybe from before: they apply with Go)');
  });
});
