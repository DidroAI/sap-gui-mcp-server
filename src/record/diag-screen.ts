/**
 * Reads the text view of the DIAG method (SAP_GUI_METHOD=diag, src/diag/view.ts)
 * into the same ParsedScreen the recorder and the replay read from SAP GUI
 * scripting and Web GUI views.
 *
 * Controls get the ids the DIAG method's actions take
 * (src/sapgui-diag/index.ts `resolveTarget`), so a recorded step and a check
 * name a control the way the agent did:
 *   VBAK-VBELN            a field, checkbox, radio button or dropdown: its SAP field name
 *   {T\01}  {HEAD}        a tab or a push button: its function code
 *   VBAP-POSNR[0]         a cell of a table control: field name and row
 *   GRID1  GRID1[3]       a grid and one of its rows; GRID1[3].VBELN a cell (checks only)
 *   {0000000042}          a tree node: its key
 *   @5,1                  a list cell: row and column
 *   Back                  a function key or toolbar button: its text (the action
 *                         may also be {"do":"key","key":3}); `vkey` holds the number
 * Windows are named as SAP GUI names them (wnd[0], wnd[1] for the first
 * popup), so what the replay knows about popups holds for both methods.
 *
 * The view is read leniently: an element it does not know is a label, and
 * notes in parentheses after an element ("(required)", "(read-only)", a
 * newer note) are kept in `rest`.
 */
import { isLogonScreen } from "../core/words.js";
import { keyName } from "../diag/text.js";
import type { Control, ParsedScreen } from "./screen.js";

/** Lines of the DIAG view start their windows with `WINDOW <n>`; scripting and Web GUI with `WINDOW wnd[<n>]`. */
export const isDiagView = (text: string): boolean => /^WINDOW \d+(?: popup)? {2}"/m.test(text);

const VKEYS = new Map<string, number>();
for (let v = 0; v < 100; v++) VKEYS.set(keyName(v).toLowerCase(), v);
/** The virtual key of a key name the view writes ("Shift+F3", "Enter", "VKey 94"). */
export const vkeyOfName = (name: string): number | undefined => VKEYS.get(name.trim().toLowerCase());

const unquote = (s: string) => s.replace(/\\(.)/g, "$1");
const NOTES = "((?: \\([^()]*\\))*)";
const END = "(?=  |$)";
const NAME = "([^\\s@=<>\\[\\]]+)@(\\d+)";
const TOKENS: { kind: string; re: RegExp }[] = [
  { kind: "box", re: new RegExp(`(\\[[x ]\\]|\\([o ]\\)) {1,2}(.*?) ?${NAME}${NOTES}${END}`, "y") },
  { kind: "dropdown", re: new RegExp(`${NAME}=dropdown (?:\\[(.*?)\\]|"((?:[^"\\\\]|\\\\.)*)")${NOTES}${END}`, "y") },
  { kind: "input", re: new RegExp(`${NAME}=\\[(.*?)\\]${NOTES}${END}`, "y") },
  { kind: "output", re: new RegExp(`${NAME}="((?:[^"\\\\]|\\\\.)*)"${NOTES}${END}`, "y") },
  { kind: "button", re: new RegExp(`<(.*?)>(?:\\{([^}]*)\\})?@(\\d+)${NOTES}${END}`, "y") },
  { kind: "group", re: new RegExp(`-- (.*?) --${END}`, "y") },
  { kind: "other", re: new RegExp(`${NAME} (.+?)${END}`, "y") },
  { kind: "label", re: /(.+?)(?= {2}|$)/y },
];

const readOnly = (notes: string) => /\(read-only\)/.test(notes);

/** The elements of one screen row (`r3  label  NAME@17="v"  <Text>{FC}@40`), as controls. */
function rowControls(row: number, text: string, window: string, scrolled: boolean): Control[] {
  const out: Control[] = [];
  const where = scrolled ? " (scrolled out of view)" : "";
  let p = 0;
  let k = 0;
  let previous: Control | undefined;
  while (p < text.length) {
    while (text[p] === " ") p++;
    if (p >= text.length) break;
    let hit: { kind: string; m: RegExpExecArray } | undefined;
    for (const t of TOKENS) {
      t.re.lastIndex = p;
      const m = t.re.exec(text);
      if (m?.[0].length) {
        hit = { kind: t.kind, m };
        break;
      }
    }
    if (!hit) break;
    p += hit.m[0].length;
    const m = hit.m;
    // A field's label is the label right before it on the row, or a read-only text field named ..TXT.. (SAP's own labels).
    const labelBefore = previous && /\p{L}/u.test(previous.value) && (previous.type === "label" || (previous.type === "field" && /TXT/.test(previous.id) && readOnly(previous.rest))) ? previous.value : "";
    let c: Control | undefined;
    switch (hit.kind) {
      case "box": {
        const checkbox = (m[1] ?? "").startsWith("[");
        c = { id: m[3] ?? "", type: checkbox ? "checkbox" : "radio", rest: `${m[0]}${where}`, label: (m[2] ?? "").trim(), value: /x|o/.test(m[1] ?? "") ? "true" : "false", window };
        break;
      }
      case "dropdown": {
        const input = m[3] !== undefined;
        c = { id: m[1] ?? "", type: "dropdown", rest: `${m[0]}${input ? "" : " (read-only)"}${where}`, label: labelBefore, value: input ? (m[3] ?? "") : unquote(m[4] ?? ""), window };
        break;
      }
      case "input":
        c = { id: m[1] ?? "", type: "field", rest: `${m[0]}${where}`, label: labelBefore, value: m[3] ?? "", window };
        break;
      case "output":
        c = { id: m[1] ?? "", type: "field", rest: `${m[0]} (read-only)${where}`, label: labelBefore, value: unquote(m[3] ?? ""), window };
        break;
      case "button":
        c = { id: m[2] ? `{${m[2]}}` : `@${row},${m[3]}`, type: "button", rest: `${m[0]}${where}`, label: m[1] ?? "", value: m[1] ?? "", window, zone: "area" };
        break;
      case "group":
        c = { id: `r${row}#${k}`, type: "box", rest: m[0], label: m[1] ?? "", value: m[1] ?? "", window };
        break;
      case "other":
        c = { id: m[1] ?? "", type: "other", rest: `${m[0]}${where}`, label: labelBefore, value: m[3] ?? "", window };
        break;
      default:
        c = { id: `r${row}#${k}`, type: "label", rest: m[0], label: m[1] ?? "", value: m[1] ?? "", window };
    }
    k++;
    out.push(c);
    previous = c;
  }
  return out;
}

/** `Display document flow (F5) | Orders: List of sales orders (F7)`: the function keys or toolbar of a window. */
function keyControls(list: string, window: string, bar: string): Control[] {
  const out: Control[] = [];
  for (const part of list.split(" | ")) {
    const m = /^(.*) \(([^()]*)\)((?: \([^()]*\))*)$/.exec(part.trim());
    const label = (m?.[1] ?? part).trim();
    const vkey = m ? vkeyOfName(m[2] ?? "") : undefined;
    // The key's own text is the part before the tooltip ("Orders: List of sales orders"): what a press by text matches.
    const text = label.includes(": ") ? (label.split(": ")[0] ?? label) : label;
    out.push({ id: text, type: "button", rest: `${part.trim()}  (${bar})`, label, value: label, window, zone: "bar", ...(vkey !== undefined ? { vkey } : {}) });
  }
  return out;
}

/** Splits `Item=10; Material=[M-08]; D=[x]` at the column handles the header defined. */
function tableCells(text: string, handles: string[]): [string, string][] {
  if (!handles.length) return [];
  const alt = [...handles].sort((a, b) => b.length - a.length).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:^|; )(${alt.join("|")})=`, "g");
  const hits = [...text.matchAll(re)];
  return hits.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = hits[i + 1]?.index ?? text.length;
    return [h[1] ?? "", text.slice(start, end)];
  });
}

interface Table {
  name: string;
  window: string;
  columns: { title: string; name: string; handle: string }[];
  lastIndex: number;
}

/** The DIAG view as a ParsedScreen. */
export function parseDiagView(text: string): ParsedScreen {
  const lines = text.split("\n");
  const out: ParsedScreen = { windows: [], controls: [], logon: false, text, method: "diag" };
  const h = /^TRANSACTION (.*?) {2}PROGRAM (.*?) {2}SCREEN (\S*)(?: {2}SYSTEM (.*?))?(?: {2}USER (\S*))?(?: {2}MODE (\d+))?$/.exec(lines[0] ?? "");
  const put = (k: "transaction" | "program" | "screen" | "system", v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t) out[k] = t;
  };
  if (h) {
    put("transaction", h[1]?.split(/\s+/)[0]);
    put("program", h[2]);
    put("screen", h[3]);
    put("system", h[4]);
  }
  let window = "";
  let block: "area" | "table" | "grid" | "tree" | "list" = "area";
  let table: Table | undefined;
  let grid: { name: string; columns: string[] } | undefined;
  let listColumns: number[] | undefined;
  const add = (c: Control) => out.controls.push(c);
  for (const l of lines.slice(1)) {
    const st = /^(?:(?:wnd\[\d+\]\/)?sbar {2})?status {2}(?:([A-Z]): )?(.*?)(?: {2}\(([^()]*)\))?$/.exec(l);
    if (st && !out.status) {
      out.status = { ...(st[1] ? { type: st[1] } : {}), text: (st[2] ?? "").trim() };
      add({ id: "status", type: "status", rest: l.replace(/^.*?status {2}/, ""), label: "", value: out.status.text, window: window || "wnd[0]" });
      continue;
    }
    const w = /^WINDOW (\d+)( popup)? {2}"((?:[^"\\]|\\.)*)"(?: {2}(\S+) (\S+))?/.exec(l);
    if (w) {
      window = `wnd[${w[1]}]`;
      out.windows.push({ id: window, title: unquote(w[3] ?? "") });
      block = "area";
      continue;
    }
    if (l.startsWith("menu: ") || l.startsWith("cursor: ") || l.startsWith("(behind the popup")) {
      if (l.startsWith("cursor: ")) block = "area";
      continue;
    }
    const keys = /^(keys|toolbar): (.*)$/.exec(l);
    if (keys) {
      for (const c of keyControls(keys[2] ?? "", window, keys[1] ?? "")) add(c);
      continue;
    }
    if (l.startsWith("  ")) {
      const inner = l.slice(2);
      if (block === "table" && table) {
        const r = /^row (\d+) r(\d+): (.*)$/.exec(inner);
        if (r) {
          const index = Number(r[1]);
          table.lastIndex = Math.max(table.lastIndex, index);
          for (const [handle, raw] of tableCells(r[3] ?? "", table.columns.map((c) => c.handle))) {
            const col = table.columns.find((c) => c.handle === handle);
            if (!col) continue;
            const input = /^\[.*\]$/.test(raw);
            const box = raw === "[x]";
            add({
              id: `${col.name}[${index}]`,
              type: box ? "checkbox" : "field",
              rest: `${raw}${input && !box ? "" : " (read-only)"}`,
              label: `${col.title || col.name}, row ${index + 1}`,
              value: box ? "true" : input ? raw.slice(1, -1) : raw,
              window: table.window,
            });
          }
          continue;
        }
        // `(2 empty rows below, from r18, open for input)`: the lines a user types new rows into.
        const e = /^\((\d+) empty rows? below, from r\d+(, open for input)?\)/.exec(inner);
        if (e?.[2]) {
          for (let i = 1; i <= Number(e[1]); i++)
            for (const col of table.columns) add({ id: `${col.name}[${table.lastIndex + i}]`, type: "field", rest: "[] (empty row)", label: `${col.title || col.name}, row ${table.lastIndex + i + 1}`, value: "", window: table.window });
        }
        continue;
      }
      if (block === "grid" && grid) {
        const r = /^row (\d+): (.*)$/.exec(inner);
        if (r) {
          const index = Number(r[1]);
          const cells = (r[2] ?? "").split(" | ");
          add({ id: `${grid.name}[${index}]`, type: "row", rest: r[2] ?? "", label: `row ${index + 1}`, value: r[2] ?? "", window });
          const g = grid;
          if (cells.length === g.columns.length) for (const [i, v] of cells.entries()) add({ id: `${g.name}[${index}].${g.columns[i]}`, type: "cell", rest: v, label: `${g.columns[i]}, row ${index + 1}`, value: v, window });
        }
        continue;
      }
      if (block === "tree") {
        const n = /^\s*(?:\[([+-])\] )?(.*?)( \(selected\))? {2}\{(.*)\}$/.exec(inner);
        if (n) add({ id: `{${n[4]}}`, type: "node", rest: inner.trim(), label: n[2] ?? "", value: n[2] ?? "", window });
        continue;
      }
      continue;
    }
    const r = /^r(\d+)( \(scrolled out of view\))? {2}(.*)$/.exec(l);
    if (r && block === "list") {
      const row = Number(r[1]);
      const cells = (r[3] ?? "").split(" | ");
      for (const [i, cell] of cells.entries()) {
        const at = /^(.*)@(\d+)$/.exec(cell);
        const col = at ? Number(at[2]) : (listColumns?.[i] ?? i);
        const v = at ? (at[1] ?? "") : cell;
        add({ id: `@${row},${col}`, type: "text", rest: v, label: v, value: v, window });
      }
      continue;
    }
    if (l.startsWith("list  ")) {
      block = "list";
      const cols = /columns at ((?:c\d+ ?)+)/.exec(l)?.[1];
      listColumns = cols ? cols.trim().split(" ").map((c) => Number(c.slice(1))) : undefined;
      add({ id: "list", type: "list", rest: l.slice(6), label: "", value: "", window });
      continue;
    }
    if (!r) continue;
    const row = Number(r[1]);
    const body = r[3] ?? "";
    block = "area";
    const tabs = /^tabs (\S+): (.*)$/.exec(body);
    if (tabs) {
      for (const part of (tabs[2] ?? "").split(" | ")) {
        const m = /^(.*?)( \(selected\))? \{(.*)\}$/.exec(part);
        if (m) add({ id: `{${m[3]}}`, type: "tab", rest: part, label: m[1] ?? "", value: m[2] ? "selected" : "", window });
      }
      continue;
    }
    const tbl = /^table (\S+)(?: "((?:[^"\\]|\\.)*)")? {2}.*? columns: (.*)$/.exec(body);
    if (tbl) {
      const cols = (tbl[3] ?? "").split(" | ").map((c) => {
        const i = c.lastIndexOf(" ");
        return i < 0 ? { title: "", name: c } : { title: c.slice(0, i), name: c.slice(i + 1) };
      });
      const count = new Map<string, number>();
      for (const c of cols) count.set(c.title, (count.get(c.title) ?? 0) + 1);
      table = { name: tbl[1] ?? "", window, lastIndex: -1, columns: cols.map((c) => ({ ...c, handle: c.title && count.get(c.title) === 1 ? c.title : `${c.title}(${c.name})` })) };
      add({ id: table.name, type: "table", rest: `${body.slice(6 + table.name.length).trim()}; columns: ${cols.map((c) => c.title || c.name).join(" | ")}`, label: unquote(tbl[2] ?? ""), value: "", window });
      block = "table";
      continue;
    }
    const g = /^grid (?:(\S+) )?\(shell (\d+)\) {2}(.*?) columns: (.*)$/.exec(body);
    if (g) {
      const name = g[1] ?? `shell ${g[2]}`;
      grid = { name, columns: (g[4] ?? "").split(" | ").map((c) => c.split("=")[0] ?? c) };
      add({ id: name, type: "grid", rest: body, label: "", value: "", window });
      block = "grid";
      continue;
    }
    const tree = /^tree (?:(\S+) )?\(shell (\d+)\)/.exec(body);
    if (tree) {
      add({ id: tree[1] ?? `shell ${tree[2]}`, type: "tree", rest: body, label: "", value: "", window });
      block = "tree";
      continue;
    }
    const te = /^text-editor (?:(\S+) )?\(shell (\d+)\)( \(read-only\))? {2}"((?:[^"\\]|\\.)*)"$/.exec(body);
    if (te) {
      add({ id: te[1] ?? `shell ${te[2]}`, type: "textedit", rest: `${te[3] ? "(read-only) " : ""}${te[4]}`, label: "", value: unquote(te[4] ?? ""), window });
      continue;
    }
    const ctl = /^control (?:(\S+) )?\(shell (\d+)\) {2}(.*)$/.exec(body);
    if (ctl) {
      add({ id: ctl[1] ?? `shell ${ctl[2]}`, type: "control", rest: ctl[3] ?? "", label: "", value: "", window });
      continue;
    }
    for (const c of rowControls(row, body, window, !!r[2])) add(c);
  }
  const top = out.windows.at(-1);
  if (top?.title) out.title = top.title;
  const main = /^WINDOW 0 /m.test(text);
  if (main && isLogonScreen(out.program, out.screen)) out.logon = true;
  return out;
}
