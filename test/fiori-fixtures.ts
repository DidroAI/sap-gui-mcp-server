/**
 * A very small stand-in for SAPUI5 and the DOM, enough for the in-page
 * functions of src/fiori/ui5.ts to run under bun test. Synthetic: no SAP data.
 */

type Props = Record<string, unknown>;

export class FakeEl {
  attrs = new Map<string, string>();
  parentElement: FakeEl | null = null;
  scrollHeight = 0;
  clientHeight = 0;
  clientWidth = 0;
  offsetWidth = 100;
  innerText = "";
  classList = { contains: (_: string) => false };
  constructor(
    public id: string,
    public tag = "div",
  ) {}
  getBoundingClientRect() {
    return { width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110 };
  }
  checkVisibility() {
    return true;
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  matches(sel: string) {
    return sel.split(",").some((s) => s.trim() === this.tag);
  }
  closest() {
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

export interface FakeSpec {
  type: string;
  id: string;
  /** Classes the control answers isA() for, besides its own. */
  isA?: string[];
  props?: Props;
  parent?: FakeControl;
  /** The aggregation of the parent this control sits in. */
  aggregation?: string;
  /** Extra methods: getLabelFor, getItems, getSelectedItem, ... */
  methods?: Record<string, (...a: never[]) => unknown>;
  handlers?: Record<string, string[]>;
  tooltip?: string;
  /** Not rendered. */
  hidden?: boolean;
}

export class FakeControl {
  [k: string]: unknown;
  dom: FakeEl | null;
  props: Props;
  sParentAggregationName: string | undefined;
  mEventRegistry: Record<string, { fFunction: { name: string } }[]> = {};
  fired: string[] = [];
  constructor(public spec: FakeSpec) {
    this.props = { ...(spec.props ?? {}) };
    this.dom = spec.hidden ? null : new FakeEl(spec.id, /Input|Field/.test(spec.type) ? "input" : "div");
    this.dom?.setAttribute("data-sap-ui", spec.id);
    this.sParentAggregationName = spec.aggregation;
    for (const [ev, names] of Object.entries(spec.handlers ?? {})) this.mEventRegistry[ev] = names.map((name) => ({ fFunction: { name } }));
    for (const [n, f] of Object.entries(spec.methods ?? {})) this[n] = f;
  }
  getId() {
    return this.spec.id;
  }
  getMetadata() {
    return {
      getName: () => this.spec.type,
      getAllProperties: () => Object.fromEntries(Object.keys(this.props).map((k) => [k, {}])),
      getAllEvents: () => Object.fromEntries(Object.keys(this.spec.handlers ?? {}).map((k) => [k, {}])),
    };
  }
  getProperty(n: string) {
    return this.props[n];
  }
  isA(t: string) {
    return t === this.spec.type || (this.spec.isA ?? []).includes(t);
  }
  getParent() {
    return this.spec.parent ?? null;
  }
  getDomRef() {
    return this.dom;
  }
  getFocusDomRef() {
    return this.dom;
  }
  getTooltip_AsString() {
    return this.spec.tooltip ?? "";
  }
  getText() {
    return this.props.text;
  }
  getTitle() {
    return this.props.title;
  }
  getSelected() {
    return this.props.selected;
  }
  getState() {
    return this.props.state;
  }
  getEditable() {
    return this.props.editable;
  }
  fireChange(p: { selectedItem?: { getText(): string } }) {
    this.fired.push(`change:${p.selectedItem?.getText() ?? ""}`);
  }
}

export const item = (key: string, text: string) => ({ getKey: () => key, getText: () => text, getEnabled: () => true });

const KEYS = ["window", "sap", "document", "innerWidth", "innerHeight", "location", "getComputedStyle", "NodeFilter"] as const;
let saved: Record<string, unknown> | undefined;

/** Installs the fake page (controls in reading order) as the globals the in-page functions use. */
export function installPage(controls: FakeControl[], page: { title?: string; hash?: string } = {}): void {
  const g = globalThis as Record<string, unknown>;
  saved ??= Object.fromEntries(KEYS.map((k) => [k, g[k]]));
  const all = Object.fromEntries(controls.map((c) => [c.getId(), c]));
  const els = controls.map((c) => c.dom).filter((e): e is FakeEl => !!e);
  const Element = { registry: { all: () => all }, getElementById: (id: string) => all[id] };
  g.sap = { ui: { getCore: () => ({ byId: (id: string) => all[id] }), require: (n: unknown) => (n === "sap/ui/core/Element" ? Element : undefined), version: "0.0.0" } };
  g.document = {
    title: page.title ?? "Fixture",
    activeElement: null,
    querySelectorAll: (sel: string) => (sel === "[data-sap-ui]" ? els : sel.startsWith("[data-sap-mcp-target") ? els.filter((e) => e.hasAttribute("data-sap-mcp-target")) : []),
    getElementById: (id: string) => els.find((e) => e.id === id) ?? null,
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  g.window = g;
  g.innerWidth = 1400;
  g.innerHeight = 900;
  g.location = { hash: page.hash ?? "#Fixture-display", search: "" };
  g.getComputedStyle = () => ({ overflowY: "visible", visibility: "visible" });
  g.NodeFilter = { SHOW_TEXT: 4 };
}

export function removePage(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of KEYS) {
    if (saved?.[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  saved = undefined;
}

/** The element the last ui5Control call marked for the driver. */
export const marked = (controls: FakeControl[]): string | undefined => controls.find((c) => c.dom?.hasAttribute("data-sap-mcp-target"))?.getId();
