/**
 * Controls (ALV grid, tree, text editor...): what the server's calls to the
 * control framework of SAP GUI say about them.
 *
 * The server sends its calls in one RFC, OLE_FLUSH_CALL, as an automation
 * queue in four tables:
 *
 *   VERBS      object (4, index of a variable), name, kind: C call a method, S set a property, G get one
 *   PARAMS     verb (4), type, parameter name ("#1", "_RESULT"...), index of its variable
 *   VARS       name (32), nine digits, "O" for an object, then the value
 *   RFC_QUEUE  the data provider's tables: each row a part of an inner RFC
 *              call, DP_PUT_CLIENT_TABLE, with a URL (DESURL), the layout of
 *              a table (FORMAT: field name, offset, length, type) and its
 *              rows (DATAASC). A row starts with a 24-character id,
 *              "SAPGUI" padded to 32, an 8-digit message number and a 4-byte
 *              part number; the parts of a message are joined in order.
 *
 * A control is made with CreateControl(shell id, class, style, parent shell)
 * and tied to a place on the screen with LinkContainer(shell id, container
 * name). The object a later verb acts on is the variable that held the
 * result of the verb that made it; in a later call it is a handle ("O15"),
 * which SAP GUI gave in its answer to the call that made the control.
 *
 * A control can also belong to a dynpro instead of a container:
 * LinkControl(shell id, program, screen number). The control-based value
 * help (F4) does that: the server opens a popup with an empty dynpro
 * (title "MCX_DUMMY_POPUP") and makes one control of class SAP.TABControl.1
 * that draws the whole dialog itself. Its caption comes with
 * createTab(caption, page), its columns with setResultTableCols (a table of
 * FIELDNAME and SCRTEXT) and all its hits at once with createResultDialog (a
 * table with one field per column). It is read as a grid.
 */
import { parseRfc, type RfcCall, type RfcTable } from "./rfc.js";
import type { DiagControl, DiagControlKind, DiagGridColumn, DiagTreeNode } from "./screen.js";
import { clean, decode } from "./text.js";

const QUEUE_HEAD = 68;

/** Verbs of the value help control that carry what it shows. */
const HIT_LIST = new Set(["createTab", "setResultTableCols", "createResultDialog"]);

/** One row of a data provider table, by field name. */
type Row = Record<string, string | number>;

interface DataTable {
  url: string;
  fields: string[];
  rows: Row[];
}

interface Verb {
  object: number;
  name: string;
  kind: string;
  /** Parameters in order: the index of the variable, and its value. */
  params: { name: string; at: number; value: string; isObject: boolean }[];
  /** Index of the variable that takes the result; 0 when there is none. */
  result: number;
}

interface GridState {
  columns: DiagGridColumn[];
  /** Cell texts by row id, then column position (1-based as sent). */
  cells: Map<number, Map<number, string>>;
  totalRows: number;
}

interface TreeState {
  nodes: Map<string, { key: string; relative: string; relation: number; folder: boolean; hidden: boolean; disabled: boolean; text: string; items: Map<string, string> }>;
  order: string[];
  expanded: Set<string>;
  allExpanded: boolean;
  headers: string[];
  selected?: string;
}

export interface ControlState {
  id: number;
  type: string;
  kind: DiagControlKind;
  parent?: number;
  container?: string;
  /** The dynpro it belongs to instead of a container (LinkControl). */
  dynpro?: { program: string; number: number };
  /** Caption the control shows for itself. */
  title?: string;
  /** It was on a screen that was given out: once its dynpro is gone, so is it. */
  shown?: boolean;
  grid?: GridState;
  tree?: TreeState;
  text?: string;
  readOnly?: boolean;
  /** Screen revision at which the server last touched it. */
  touched: number;
  /** The internal mode it was made in (session sub-id 0a): it ends with that mode. */
  internalMode?: number;
}

function kindOf(type: string): DiagControlKind {
  const t = type.toLowerCase();
  if (t.includes("gridview") || t.includes("tabcontrol")) return "grid";
  if (t.includes("tree")) return "tree";
  if (t.includes("textedit")) return "text";
  if (t.includes("toolbar")) return "toolbar";
  if (t.includes("html")) return "html";
  if (t.includes("picture")) return "picture";
  if (t.includes("splitter")) return "splitter";
  if (t.includes("container") || t.includes("docking")) return "container";
  return "other";
}

/** The inner calls of the RFC_QUEUE table, parts joined by message number. */
function queueCalls(queue: RfcTable | undefined): RfcCall[] {
  if (!queue) return [];
  const messages = new Map<string, Buffer[]>();
  for (const row of queue.rows) {
    if (row.length <= QUEUE_HEAD) continue;
    const number = row.toString("latin1", 56, 64);
    let parts = messages.get(number);
    if (!parts) {
      parts = [];
      messages.set(number, parts);
    }
    parts.push(row.subarray(QUEUE_HEAD));
  }
  return [...messages.values()].map((parts) => parseRfc(Buffer.concat(parts)));
}

/** A data provider table decoded with its FORMAT: offset, length (uint32 little-endian at 64 and 68) and type (at 76) per field. */
function dataTable(call: RfcCall, utf8: boolean): DataTable | undefined {
  const url = clean(decode(call.params.get("DESURL") ?? Buffer.alloc(0), false)).trim();
  const format = call.tables.get("FORMAT");
  const data = call.tables.get("DATAASC");
  if (!url || !format || !data) return undefined;
  const fields = format.rows
    .filter((r) => r.length >= 77)
    .map((r) => ({ name: r.toString("latin1", 30, 60).trim(), offset: r.readUInt32LE(64), length: r.readUInt32LE(68), type: String.fromCharCode(r[76] ?? 0x43) }));
  const rows = data.rows.map((r) => {
    const row: Row = {};
    for (const f of fields) {
      if (f.offset + f.length > r.length) continue;
      if (f.type === "I" && f.length === 4) row[f.name] = r.readInt32LE(f.offset);
      else if (f.type === "s" && f.length === 2) row[f.name] = r.readInt16LE(f.offset);
      else row[f.name] = clean(decode(r.subarray(f.offset, f.offset + f.length), utf8));
    }
    return row;
  });
  return { url, fields: fields.map((f) => f.name), rows };
}

const str = (v: string | number | undefined): string => (v === undefined ? "" : String(v));
const num = (v: string | number | undefined): number => (typeof v === "number" ? v : Number(v) || 0);

/** The verbs of a call with their parameters resolved. */
function verbsOf(call: RfcCall, utf8: boolean): Verb[] {
  const vars = (call.tables.get("VARS")?.rows ?? []).map((r) => ({ isObject: r[41] === 0x4f, value: clean(decode(r.subarray(42), utf8)) }));
  const verbs: Verb[] = (call.tables.get("VERBS")?.rows ?? []).map((r) => {
    const s = decode(r, false);
    return { object: Number(s.slice(0, 10)) || 0, name: s.slice(10, 52).trim(), kind: s.slice(52, 53), params: [], result: 0 };
  });
  for (const r of call.tables.get("PARAMS")?.rows ?? []) {
    const s = decode(r, false);
    const verb = verbs[(Number(s.slice(0, 4)) || 0) - 1];
    if (!verb) continue;
    const name = s.slice(8, 40).trim();
    const at = Number(s.slice(40)) || 0;
    const v = vars[at - 1];
    if (name.startsWith("_RESULT")) verb.result = at;
    else verb.params.push({ name, at, value: v?.value ?? "", isObject: v?.isObject ?? false });
  }
  // The object of a verb: a result of this call, or a handle from an earlier one.
  for (const verb of verbs) {
    const v = vars[verb.object - 1];
    if (v?.isObject && /^\d+$/.test(v.value)) verb.params.unshift({ name: "_OBJECT", at: verb.object, value: v.value, isObject: true });
  }
  return verbs;
}

export class Controls {
  readonly controls = new Map<number, ControlState>();
  /** Handles SAP GUI gave to control objects, to their shell ids. */
  private handles = new Map<string, number>();
  /** Verbs of the last call that made controls, until SAP GUI answers with their handles: verb number to shell id. */
  private pending = new Map<number, number>();

  constructor(private readonly note: (what: string) => void) {}

  /** A call of the server to SAP GUI. Returns true when it changed a control. */
  serverCall(call: RfcCall, utf8: boolean, revision: number, internalMode?: number): boolean {
    if (call.function !== "OLE_FLUSH_CALL") return false;
    const tables = new Map<string, DataTable>();
    for (const inner of queueCalls(call.tables.get("RFC_QUEUE"))) {
      const t = dataTable(inner, utf8);
      if (t) tables.set(t.url, t);
      else if (inner.function) this.note(`data provider call ${inner.function}`);
    }
    const verbs = verbsOf(call, utf8);
    /** Result variable of a verb of this call, to the shell id of the control it made. */
    const made = new Map<number, number>();
    /** Data provider objects (grid): by the variable that holds them. */
    const providers = new Map<number, { handle: number; urls: string[]; lineCount: number }>();
    const assigned: { handle: number; shell: number; property?: string }[] = [];
    this.pending = new Map();
    let lastUrl = "";
    let current: ControlState | undefined;
    let changed = false;
    const resolve = (verb: Verb): ControlState | undefined => {
      const shell = made.get(verb.object) ?? (verb.params[0]?.name === "_OBJECT" ? this.handles.get(verb.params[0].value) : undefined);
      return shell === undefined ? undefined : this.controls.get(shell);
    };
    verbs.forEach((verb, index) => {
      const p = verb.params.filter((x) => x.name !== "_OBJECT");
      const arg = (n: number) => p[n]?.value ?? "";
      if (verb.name === "CreateControl" || verb.name === "CreateControl2") {
        const id = Number(arg(0));
        if (!id) return;
        const type = arg(1);
        const parent = made.get(p[3]?.at ?? -1) ?? (Number(arg(3)) || undefined);
        // A shell id is SAP GUI's while its control lives: one made again means the old control, and what hung in it, is gone.
        if (this.controls.has(id)) this.dropTree(id);
        const c: ControlState = { id, type, kind: kindOf(type), touched: revision, ...(parent !== undefined ? { parent } : {}), ...(internalMode !== undefined ? { internalMode } : {}) };
        if (c.kind === "grid") c.grid = { columns: [], cells: new Map(), totalRows: 0 };
        if (c.kind === "tree") c.tree = { nodes: new Map(), order: [], expanded: new Set(), allExpanded: false, headers: [] };
        this.controls.set(id, c);
        if (verb.result) made.set(verb.result, id);
        this.pending.set(index + 1, id);
        current = c;
        changed = true;
        return;
      }
      if (verb.name === "LinkContainer") {
        const c = this.controls.get(Number(arg(0)));
        if (c) c.container = arg(1);
        return;
      }
      if (verb.name === "LinkControl") {
        const c = this.controls.get(Number(arg(0)));
        if (c) c.dynpro = { program: arg(1).trim(), number: Number(arg(2)) || 0 };
        return;
      }
      if (HIT_LIST.has(verb.name)) {
        // The value help control: by its handle, else the one there is.
        const c = resolve(verb) ?? [...this.controls.values()].reverse().find((x) => /tabcontrol/i.test(x.type));
        if (c?.grid) changed = this.hitList(c, verb.name, arg, tables.get(lastUrl), revision) || changed;
        return;
      }
      if (verb.name === "DestroyControl" || verb.name === "DeleteControl") {
        changed = this.controls.delete(Number(arg(0))) || changed;
        return;
      }
      if (verb.name === "SetDataFromUrl") {
        lastUrl = p.map((x) => x.value).find((x) => x.startsWith("SAPR3://")) ?? lastUrl;
        return;
      }
      if (verb.name === "Handle" && verb.kind === "S") {
        providers.set(verb.object, { handle: Number(arg(0)), urls: [], lineCount: 0 });
        return;
      }
      if (verb.name === "LineCount" && verb.kind === "S") {
        const dp = providers.get(verb.object);
        if (dp) dp.lineCount = Number(arg(0)) || 0;
        return;
      }
      if (verb.name === "InsertPacket") {
        const dp = providers.get(verb.object);
        if (dp) dp.urls.push(lastUrl);
        else this.loosePacket(tables.get(lastUrl), revision);
        return;
      }
      if (verb.name === "AssignDataObjToShell") {
        assigned.push({ handle: Number(arg(0)), shell: Number(arg(1)) });
        return;
      }
      if (verb.name === "AssignProperty2") {
        const property = arg(3);
        const lastAssigned = assigned[assigned.length - 1];
        if (arg(1) === "r3TableAutoObj") {
          // A table given to a control as a whole: the grid's field catalog.
          const target = this.controls.get(made.get(p[2]?.at ?? -1) ?? -1) ?? current;
          if (target?.grid && property === "InfoTable") changed = this.gridColumns(target, tables.get(lastUrl), revision) || changed;
        } else if (lastAssigned && lastAssigned.property === undefined) lastAssigned.property = property;
        return;
      }
      const own = resolve(verb);
      // What a verb on a control returns (a container of a splitter, the headers of a tree) stands for that control.
      if (own && verb.result && !made.has(verb.result)) made.set(verb.result, own.id);
      if (own) current = own;
      const target = own ?? (verb.kind !== "C" || /Table|Expand|Node/.test(verb.name) ? current : undefined);
      if (!target) return;
      if (target.tree) changed = this.treeVerb(target, verb, arg, tables.get(lastUrl), revision) || changed;
      else if (target.grid) {
        if (verb.name === "DeleteAllCells") {
          target.grid.cells.clear();
          target.touched = revision;
          changed = true;
        }
      } else if (target.kind === "text") changed = this.textVerb(target, verb, arg, tables.get(lastUrl), revision) || changed;
    });
    for (const a of assigned) {
      const c = this.controls.get(a.shell);
      const dp = [...providers.values()].find((x) => x.handle === a.handle);
      if (!c?.grid || !dp) continue;
      if (a.property === "DataTableOnDemand") {
        for (const url of dp.urls) changed = this.gridCells(c, tables.get(url), revision) || changed;
      } else if (a.property === "RowIDNumericOnDemand") {
        c.grid.totalRows = dp.lineCount;
        c.touched = revision;
      }
    }
    return changed;
  }

  /** SAP GUI's answer to the last call: the handles of the objects the call made. */
  clientAnswer(call: RfcCall): void {
    if (!this.pending.size) return;
    const vars = call.tables.get("VARS")?.rows ?? [];
    for (const r of call.tables.get("PARAMS")?.rows ?? []) {
      const s = decode(r, false);
      if (!s.slice(8, 40).trim().startsWith("_RESULT")) continue;
      const shell = this.pending.get(Number(s.slice(0, 4)) || 0);
      const v = vars[(Number(s.slice(40)) || 0) - 1];
      if (shell === undefined || !v || v[41] !== 0x4f) continue;
      const handle = clean(decode(v.subarray(42), false)).trim();
      if (handle) this.handles.set(handle, shell);
    }
    this.pending = new Map();
  }

  /** The value help control: caption, columns (FIELDNAME, SCRTEXT) and hits (one field per column, all rows at once). */
  private hitList(c: ControlState, verb: string, arg: (n: number) => string, t: DataTable | undefined, revision: number): boolean {
    if (!c.grid) return false;
    if (verb === "createTab") c.title = arg(0).trim();
    else if (verb === "setResultTableCols" && t) {
      c.grid.columns = t.rows.map((r, i) => {
        const title = str(r.SCRTEXT).trim();
        return { name: str(r.FIELDNAME).trim(), title, titles: title ? [title] : [], tooltip: "", width: 0, position: i };
      });
    } else if (verb === "createResultDialog" && t) {
      c.grid.cells.clear();
      // Columns the control was not told about (a hit list without setResultTableCols) are the fields of the table.
      if (!c.grid.columns.length) c.grid.columns = t.fields.map((name, i) => ({ name, title: name, titles: [name], tooltip: "", width: 0, position: i }));
      const columns = c.grid.columns;
      t.rows.forEach((r, i) => {
        c.grid?.cells.set(i + 1, new Map(columns.map((col) => [col.position + 1, str(r[col.name]).trim()])));
      });
      c.grid.totalRows = t.rows.length;
    } else return false;
    c.touched = revision;
    return true;
  }

  /** Forgets a control and every control that hangs in it. */
  private dropTree(id: number): void {
    const gone = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of this.controls.values())
        if (c.parent !== undefined && gone.has(c.parent) && !gone.has(c.id)) {
          gone.add(c.id);
          grew = true;
        }
    }
    for (const g of gone) this.controls.delete(g);
  }

  /** The server ended an internal mode: SAP GUI frees the controls made in it. Returns true when one was dropped. */
  endMode(internalMode: number): boolean {
    let changed = false;
    for (const [id, c] of this.controls) {
      if (c.internalMode !== internalMode) continue;
      this.controls.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Forgets the controls of a dynpro that was on the screen and is not any more (a closed value help). `on` says whether a dynpro is on show. */
  dropClosed(on: (program: string, number: number) => boolean): void {
    for (const [id, c] of this.controls) {
      if (!c.dynpro) continue;
      const open = on(c.dynpro.program, c.dynpro.number);
      if (open) c.shown = true;
      else if (c.shown) this.controls.delete(id);
    }
  }

  /** A packet for a data provider made in an earlier call: more rows of the one grid there is. */
  private loosePacket(t: DataTable | undefined, revision: number): void {
    if (!t) return;
    const grids = [...this.controls.values()].filter((c) => c.grid);
    const grid = grids[grids.length - 1];
    if (grid && t.fields.length >= 13 && t.rows.length && typeof t.rows[0]?.["4"] === "string") this.gridCells(grid, t, revision);
  }

  /** The grid's field catalog. Its fields have numbers for names: 1 column name, 3 position, 4 long text, 5 width, 15 to 17 header texts. */
  private gridColumns(c: ControlState, t: DataTable | undefined, revision: number): boolean {
    if (!c.grid || !t) return false;
    c.grid.columns = t.rows.map((r, i) => {
      const long = str(r["4"]).trim();
      const titles = [long, str(r["17"]).trim(), str(r["15"]).trim(), str(r["16"]).trim()].filter(Boolean);
      return { name: str(r["1"]).trim(), title: long || titles[0] || "", titles: [...new Set(titles)], tooltip: str(r["9"]).trim() || long, width: num(r["5"]), position: num(r["3"]) ? num(r["3"]) - 1 : i };
    });
    c.touched = revision;
    return true;
  }

  /** Cells of a grid: field 1 the column position (-1 the row header), 2 the row, 4 the text. */
  private gridCells(c: ControlState, t: DataTable | undefined, revision: number): boolean {
    if (!c.grid || !t) return false;
    for (const r of t.rows) {
      const col = num(r["1"]);
      const row = num(r["2"]);
      if (col < 1 || row < 1) continue;
      let cells = c.grid.cells.get(row);
      if (!cells) {
        cells = new Map();
        c.grid.cells.set(row, cells);
      }
      cells.set(col, str(r["4"]).trim());
    }
    c.touched = revision;
    return t.rows.length > 0;
  }

  private treeVerb(c: ControlState, verb: Verb, arg: (n: number) => string, t: DataTable | undefined, revision: number): boolean {
    const tree = c.tree;
    if (!tree) return false;
    const name = verb.name;
    if (/R3Table|ItemTable|NodeTable|NodesTable/.test(name) && verb.kind === "C") {
      if (!t) return false;
      const isItems = t.fields.includes("ITEM_NAME");
      for (const r of t.rows) {
        const key = str(r.NODE_KEY);
        if (!key) continue;
        if (isItems) {
          const node = tree.nodes.get(key);
          if (!node) continue;
          const text = str(r.TEXT).trim();
          node.items.set(str(r.ITEM_NAME), text);
          if (!node.text) node.text = text;
        } else {
          if (!tree.nodes.has(key)) tree.order.push(key);
          const old = tree.nodes.get(key);
          tree.nodes.set(key, { key, relative: str(r.RELATKEY), relation: num(r.RELATSHIP), folder: str(r.ISFOLDER) === "X", hidden: str(r.HIDDEN) === "X", disabled: str(r.DISABLED) === "X", text: str(r.TEXT).trim(), items: old?.items ?? new Map() });
        }
      }
      c.touched = revision;
      return true;
    }
    if (/DeleteAll|RemoveAll/.test(name)) {
      tree.nodes.clear();
      tree.order = [];
      tree.expanded.clear();
      tree.allExpanded = false;
    } else if (/Delete.*Node|Remove.*Node/.test(name)) {
      tree.nodes.delete(arg(0));
      tree.order = tree.order.filter((k) => k !== arg(0));
    } else if (/ExpandAll/.test(name)) tree.allExpanded = true;
    else if (/Collapse.*All/.test(name)) {
      tree.allExpanded = false;
      tree.expanded.clear();
    } else if (/Expand/.test(name) && verb.kind === "C") tree.expanded.add(arg(0));
    else if (/Collapse/.test(name) && verb.kind === "C") tree.expanded.delete(arg(0));
    else if (name === "ABAPSelNodeKey" && verb.kind === "S") tree.selected = arg(0);
    else if (name === "Heading" && verb.kind === "S") tree.headers.push(arg(0).trim());
    else return false;
    c.touched = revision;
    return true;
  }

  private textVerb(c: ControlState, verb: Verb, arg: (n: number) => string, t: DataTable | undefined, revision: number): boolean {
    if (verb.kind === "S" && verb.name === "TextStream") c.text = arg(0);
    else if (verb.kind === "S" && verb.name === "ReadOnly") c.readOnly = arg(0) === "1";
    else if (verb.kind === "C" && /Table/.test(verb.name) && t) {
      // A longer text comes as a table of lines: the first character field of each row.
      c.text = t.rows.map((r) => str(Object.values(r).find((x) => typeof x === "string"))).join("\n");
      this.note(`text editor filled by ${verb.name}: read as lines of a table, unverified`);
    } else return false;
    c.touched = revision;
    return true;
  }

  /** The controls as the screen model has them. */
  snapshot(): DiagControl[] {
    return [...this.controls.values()].map((c) => {
      const out: DiagControl = { id: c.id, kind: c.kind, type: c.type, ...(c.parent !== undefined ? { parent: c.parent } : {}) };
      const container = this.containerOf(c);
      if (container) out.container = container;
      if (c.dynpro) out.dynpro = { ...c.dynpro };
      if (c.title) out.title = c.title;
      if (c.grid) {
        const columns = [...c.grid.columns].sort((a, b) => a.position - b.position);
        const ids = [...c.grid.cells.keys()].sort((a, b) => a - b);
        out.grid = { columns, rows: ids.map((id) => ({ index: id - 1, cells: columns.map((col) => c.grid?.cells.get(id)?.get(col.position + 1) ?? "") })), totalRows: Math.max(c.grid.totalRows, ids.length) };
      }
      if (c.tree) out.tree = { headers: c.tree.headers.filter(Boolean), nodes: treeNodes(c.tree), ...(c.tree.selected ? { selected: c.tree.selected } : {}) };
      if (c.text !== undefined) out.text = c.text;
      if (c.readOnly !== undefined) out.readOnly = c.readOnly;
      return out;
    });
  }

  /** The custom container a control hangs in: its own, or its nearest ancestor's. */
  private containerOf(c: ControlState): string | undefined {
    let at: ControlState | undefined = c;
    for (let i = 0; at && i < 20; i++) {
      if (at.container) return at.container;
      at = at.parent === undefined ? undefined : this.controls.get(at.parent);
    }
    return undefined;
  }
}

/** Relations of a node to the node it names (seen: 3 puts "Favorites" before the SAP menu, 6 appends a child; the others from SAP's tree model). */
const RELATION = { FIRST_SIBLING: 1, LAST_SIBLING: 2, PREV_SIBLING: 3, FIRST_CHILD: 4, NEXT_SIBLING: 5, LAST_CHILD: 6 } as const;

/** The nodes in display order with their depth. */
function treeNodes(tree: TreeState): DiagTreeNode[] {
  const children = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const list = (parent: string): string[] => {
    let l = children.get(parent);
    if (!l) {
      l = [];
      children.set(parent, l);
    }
    return l;
  };
  for (const key of tree.order) {
    const n = tree.nodes.get(key);
    if (!n) continue;
    const relative = n.relative && tree.nodes.has(n.relative) ? n.relative : "";
    const child = relative === "" || n.relation === RELATION.FIRST_CHILD || n.relation === RELATION.LAST_CHILD || n.relation === 0;
    const parent = child ? relative : (parentOf.get(relative) ?? "");
    parentOf.set(key, parent);
    const siblings = list(parent);
    const at = siblings.indexOf(relative);
    if (child && n.relation === RELATION.FIRST_CHILD) siblings.unshift(key);
    else if (child) siblings.push(key);
    else if (n.relation === RELATION.FIRST_SIBLING) siblings.unshift(key);
    else if (n.relation === RELATION.NEXT_SIBLING && at >= 0) siblings.splice(at + 1, 0, key);
    else if (n.relation === RELATION.PREV_SIBLING && at >= 0) siblings.splice(at, 0, key);
    else siblings.push(key);
  }
  const out: DiagTreeNode[] = [];
  const walk = (parent: string, depth: number) => {
    for (const key of children.get(parent) ?? []) {
      const n = tree.nodes.get(key);
      if (!n) continue;
      const kids = children.get(key)?.length ?? 0;
      out.push({ key, parent, depth, text: n.text, items: Object.fromEntries(n.items), folder: n.folder || kids > 0, expanded: kids > 0 && (tree.allExpanded || tree.expanded.has(key)), hidden: n.hidden, disabled: n.disabled });
      walk(key, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
