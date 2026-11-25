/**
 * The full text view of an SAP GUI screen, from the host's facts.
 *
 * The format: a header line (transaction, program, screen), a WINDOW line
 * per window, then one line per control:
 *
 *   <scripting id>  <type>  <label and value>  <state>
 *
 * with two spaces between the parts. Containers give no line. An ALV grid
 * gives its columns, then one indented line per row; a tree, one indented
 * line per node that is on show, with its key as {node <key>}; a text editor
 * its text; a toolbar inside a container its buttons, each with its function
 * code as {<code>}. A password field never shows its content. The Web GUI
 * reader writes the same format, and core/compact.ts shortens both.
 */
import type { Control, Screen } from "./facts.js";

/** Containers and frames: they hold controls and show nothing themselves. */
const SKIP = new Set([
  "GuiUserArea",
  "GuiSimpleContainer",
  "GuiScrollContainer",
  "GuiCustomControl",
  "GuiContainerShell",
  "GuiSplitterContainer",
  "GuiDockShell",
  "GuiTitlebar",
  "GuiMenubar",
  "GuiTabStrip",
  "GuiMenu",
]);

const BLANK = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+";
const EDGES = new RegExp(`^${BLANK}|${BLANK}$`, "g");

/** One line, no outer blanks. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/\n/g, " ")
    .replace(EDGES, "");
}

function shellLines(c: Control): string[] {
  if (c.error !== undefined) return [`${c.id}  shell error ${esc(c.error)}`];
  const out: string[] = [];
  if (c.sub === "GridView" && c.grid) {
    const g = c.grid;
    const first = g.first ?? 0;
    out.push(`${c.id}  grid  ${g.rowCount} rows; columns: ${g.cols.map((col, i) => `${col}=${esc(g.titles[i])}`).join(" | ")}`);
    g.rows.forEach((cells, r) => out.push(`  row ${first + r}: ${cells.map(esc).join(" | ")}`));
    if (g.rowCount > g.rows.length) out.push(`  ... ${g.rowCount - g.rows.length} more rows (shown: ${first} to ${first + g.rows.length - 1}; scroll for the others)`);
  } else if (c.sub === "Tree" && c.tree) {
    const heads = c.tree.headers.map(esc).filter(Boolean);
    // A tree longer than the host reads at once says which part this is.
    const part = c.tree.nodes.length < c.tree.shown ? ` (${c.tree.nodes.length} listed, first ${c.tree.first ?? 0}; scroll for the others)` : "";
    out.push(`${c.id}  tree  ${c.tree.shown} nodes shown${part}${heads.length ? `; columns: ${heads.join(" | ")}` : ""}`);
    for (const n of c.tree.nodes) {
      // Column trees keep more text in item columns; the same text twice is shown once.
      const text = n.items ? [...new Set([esc(n.text), ...n.items.map(esc)].filter(Boolean))].join(" | ") : esc(n.text);
      const state = n.folder ? (n.expanded ? "[-] " : "[+] ") : "";
      out.push(`  ${"  ".repeat(n.depth)}${state}${text}  {node ${esc(n.key)}}`);
    }
  } else if (c.sub === "TextEdit") {
    out.push(`${c.id}  text-editor  "${esc(c.text).slice(0, 2000)}"`);
  } else if (c.sub === "Toolbar") {
    const buttons = (c.buttons ?? []).map((b) => `${esc(b.text) || esc(b.tip)} {${b.id}}${b.type === "Menu" ? " (menu)" : b.type === "ButtonAndMenu" ? " (also a menu)" : ""}`);
    if (buttons.length) out.push(`${c.id}  toolbar  ${buttons.join(", ")}`);
  } else if (c.sub === "HTMLViewer") {
    out.push(`${c.id}  html-viewer`);
  } else {
    out.push(`${c.id}  shell ${c.sub ?? ""}`);
  }
  return out;
}

/** The lines one control gives: none for a container, several for a grid or a tree. */
export function controlLines(c: Control): string[] {
  const t = c.type;
  if (t === "GuiShell") return shellLines(c);
  const id = c.id;
  const text = esc(c.text);
  const tip = esc(c.tip);
  // A classic list that scrolls: its cells (lbl[col,row]) follow as their own lines.
  if (t === "GuiUserArea" && c.scroll)
    return [`${id}  list  ${c.scroll.maximum + c.scroll.pageSize} rows (visible ${c.scroll.pageSize}${c.scroll.position ? `, first ${c.scroll.position}` : ""}; scroll for the others)`];
  if (t === "GuiMenubar") return [`${id}  menubar  ${(c.menus ?? []).map((m, i) => `${esc(m)} {menu[${i}]}`).join(", ")}`];
  if (SKIP.has(t)) return [];
  if (t === "GuiTextField" || t === "GuiCTextField" || t === "GuiPasswordField") {
    const value = t === "GuiPasswordField" ? "" : text;
    return [`${id}  field  ${esc(c.label) || tip} = "${value}"  (${c.changeable ? "edit" : "read-only"})`];
  }
  // A value shown as text, named by the label before it (forAgent gives it that label).
  if (t === "GuiLabel") return text ? [`${id}  label  ${c.label && esc(c.label) !== text ? `${esc(c.label)}: ` : ""}${text}`] : [];
  if (t === "GuiCheckBox") return [`${id}  checkbox  [${c.selected ? "x" : " "}] ${text || tip}`];
  if (t === "GuiRadioButton") return [`${id}  radio  [${c.selected ? "x" : " "}] ${text || tip}`];
  if (t === "GuiComboBox") {
    const all = c.entries ?? [];
    const options = all.slice(0, 30).map(([k, v]) => `${esc(k)}:${esc(v)}`);
    return [`${id}  dropdown  ${esc(c.label) || tip} = "${esc(c.key)}" ${text}  ${all.length} options: ${options.join(", ")}${all.length > 30 ? ", ..." : ""}`];
  }
  if (t === "GuiButton") return [`${id}  button  ${text || tip}${text && tip && tip !== text ? `  (${tip})` : ""}`];
  if (t === "GuiTab") return [`${id}  tab  ${text}`];
  if (t === "GuiStatusbar") {
    const type = esc(c.messageType);
    return text ? [`${id}  status  ${type ? `${type}: ` : ""}${text}`] : [];
  }
  if (t === "GuiBox") return text ? [`${id}  group  ${text}`] : [];
  if (t === "GuiTableControl")
    return [`${id}  table  rows ${c.rowCount ?? "None"} (visible ${c.visibleRowCount ?? "None"}${c.firstRow ? `, first ${c.firstRow}` : ""}); columns: ${(c.columns ?? []).map(esc).join(" | ")}`];

  if (t === "GuiOkCodeField") return [`${id}  command-field`];
  return text ? [`${id}  ${t.slice(3).toLowerCase()}  ${text}`] : [];
}

/** A cell of a classic list: a control named by its place only, "lbl[3,5]" or "chk[0,5]", right under the user area. */
const LIST_CELL = /^[a-z]+\[\d+,\d+\]$/;

/**
 * The screen with a scrollbar kept only on user areas that are classic
 * lists. SAP GUI gives a selection screen's user area a vertical scrollbar
 * too (VA05, MMBE, ME23N: "785 rows"), but its fields are all readable and
 * nothing there scrolls like a list.
 */
export function listsOnly(s: Screen): Screen {
  for (const w of s.windows)
    for (const c of w.controls) {
      if (c.type !== "GuiUserArea" || !c.scroll) continue;
      const inside = `${c.id}/`;
      if (!w.controls.some((x) => x.id.startsWith(inside) && LIST_CELL.test(x.id.slice(inside.length)))) delete c.scroll;
    }
  return s;
}

/** SAP GUI's own buttons in the system toolbar: a new window, a shortcut, its settings menu. Nothing of the transaction. */
const GUI_BUTTONS = /^wnd\[\d+\]\/tbar\[0\]\/btn\[(418|419|446)\]$/;
/** The prefix of a screen element's id that says its kind: "lbl", "ctxt", "txt", ... */
const KIND = /^(lbl|ctxt|txt|cmb|chk|rad|pwd)(.+)$/;
const last = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/**
 * The screen as the agent's (compact) view shows it, without what SAP GUI
 * adds around the transaction and the Web GUI view does not have:
 *
 * - the window's own line (the WINDOW line names it);
 * - the status bar's panes (pane[0] repeats the status bar's message);
 * - SAP GUI's buttons for a new window, a shortcut and its settings, the
 *   "More" button of the toolbar (the buttons it folds away are on the view
 *   anyway), and Enter in the main window's system toolbar (key Enter);
 * - a field's label when it is its own line too ("lblVBAK-AUART label Order
 *   Type" before the field that already says "Order Type"), and a selection
 *   screen's texts (the criterion's name and "to" before its fields, its
 *   operator button while it has none).
 *
 * Measured live on FB50 (2026-11-25): 18 of 64 lines. Every control stays
 * in the full view (sap_look full) and can still be acted on.
 */
export function forAgent(s: Screen): Screen {
  return {
    ...s,
    windows: s.windows.map((w) => {
      // Copies: a field may take a label's text, and the screen read stays as it was for the full view.
      const all = w.controls.map((c) => ({ ...c }));
      const fields = new Map<string, Control>();
      const labels = new Set<string>();
      for (const c of all) {
        const k = KIND.exec(last(c.id));
        if (k && k[1] !== "lbl") fields.set(`${c.id.slice(0, c.id.lastIndexOf("/") + 1)}${k[2]}`, c);
        if (c.label) labels.add(esc(c.label));
      }
      const controls: Control[] = [];
      for (const c of all) {
        if (c.type === "GuiMainWindow" || c.type === "GuiModalWindow" || c.type === "GuiFrameWindow" || c.type === "GuiStatusPane") continue;
        if (c.type === "GuiButton" && (GUI_BUTTONS.test(c.id) || last(c.id) === "btnvhmore" || (w.id === "wnd[0]" && c.id === "wnd[0]/tbar[0]/btn[0]"))) continue;
        // A selection screen's texts are fields of their own: "txt%_MS_MATNR_%_APP_%-TEXT" = "Material" before the field
        // labelled Material, "-TO_TEXT" = "to"; the operator button "-OPTI_PUSH" is an empty read-only field until one is chosen.
        const sel = /%_APP_%-(TEXT|TO_TEXT|OPTI_PUSH)$/.exec(c.name);
        if (sel && c.changeable === false && (sel[1] === "OPTI_PUSH" ? !esc(c.text) : labels.has(esc(c.text)))) continue;
        if (c.type === "GuiLabel") {
          const k = KIND.exec(last(c.id));
          const field = k?.[1] === "lbl" ? fields.get(`${c.id.slice(0, c.id.lastIndexOf("/") + 1)}${k[2]}`) : undefined;
          const text = esc(c.text);
          if (field && !esc(field.label) && text) {
            // The field had no left label of its own: it takes this one's text, and the label's line goes.
            field.label = text;
            labels.add(text);
            continue;
          }
          if (text && (labels.has(text) || (field && esc(field.label) === text))) continue;
        }
        controls.push(c);
      }
      return { ...w, controls };
    }),
  };
}

export function fullView(s: Screen): string {
  const out = [`TRANSACTION ${s.transaction}  PROGRAM ${s.program}  SCREEN ${s.screen}`];
  for (const w of s.windows) {
    out.push(`WINDOW ${w.id}  "${esc(w.title)}"`);
    for (const c of w.controls) out.push(...controlLines(c));
  }
  return out.join("\n");
}
