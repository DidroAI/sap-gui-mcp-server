/**
 * Reads facts back from the text view of a screen (the full view of
 * `Driver.look`): where it is, the status bar, and each control's id, type,
 * label and value. The recorder and the replay only know a screen through
 * this file, so a change of the view's format is absorbed here.
 *
 * SAP GUI and Web GUI share one format:
 *   TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 4001  SYSTEM ABA (800)
 *   WINDOW wnd[0]  "Display Standard Order 19097: Overview"
 *   wnd[0]/usr/ctxtVBAK-VBELN  field  Standard Order = "19097"  (read-only)
 *   wnd[0]/sbar  status  S: Order 19097 saved
 * Fiori has its own (a `FIORI <intent>` header, indented control lines,
 * `TOAST "..."`): only the header, the toasts and the text are read from it.
 */

export interface ScreenRef {
  /** Transaction code, or on Fiori the app's intent. */
  transaction?: string;
  program?: string;
  /** Screen (dynpro) number. */
  screen?: string;
  /** Title of the top window. */
  title?: string;
}

export interface StatusMessage {
  /** S success, I information, W warning, E error, A abort; absent when the view does not say. */
  type?: string;
  text: string;
}

export interface Control {
  id: string;
  type: string;
  /** Everything after the type. */
  rest: string;
  label: string;
  /** Field and dropdown: the value. Checkbox and radio: "true" or "false". Tab: "selected" or "". Others: their text. */
  value: string;
  window: string;
}

export interface ParsedScreen extends ScreenRef {
  /** "ABA (800)" as the header shows it. */
  system?: string;
  status?: StatusMessage;
  windows: { id: string; title: string }[];
  controls: Control[];
  logon: boolean;
  text: string;
}

const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

function control(id: string, type: string, rest: string, window: string): Control {
  let label = rest;
  let value = rest;
  if (type === "field" || type === "dropdown") {
    const m = /^(.*?) ?= "((?:[^"\\]|\\.)*)"/.exec(rest);
    if (m) {
      label = (m[1] ?? "").trim();
      value = unquote(m[2] ?? "");
    }
  } else if (type === "checkbox" || type === "radio") {
    const m = /^\[(x| )\] ?(.*)$/.exec(rest);
    if (m) {
      value = m[1] === "x" ? "true" : "false";
      label = (m[2] ?? "").trim();
    }
  } else if (type === "tab") {
    const selected = /\s*\(selected\)\s*$/.test(rest);
    label = rest.replace(/\s*\(selected\)\s*$/, "");
    value = selected ? "selected" : "";
  } else if (type === "status") {
    const m = /^([A-Z]): (.*)$/.exec(rest);
    value = m ? (m[2] ?? "") : rest;
    label = "";
  } else if (type === "button") {
    label = rest.split("  (")[0] ?? rest;
  }
  return { id, type, rest, label, value, window };
}

export function parseScreen(text: string): ParsedScreen {
  const lines = text.split("\n");
  const head = lines[0] ?? "";
  const out: ParsedScreen = { windows: [], controls: [], logon: false, text };
  const put = (k: "transaction" | "program" | "screen" | "system", v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t) out[k] = t;
  };
  if (head.startsWith("FIORI")) {
    const parts = head.split("  ");
    put("transaction", parts[1] && !/^(system|client|user) /.test(parts[1]) ? parts[1] : undefined);
    put("system", parts.find((p) => p.startsWith("system "))?.slice(7));
    const toasts = lines.filter((l) => l.startsWith('TOAST "')).map((l) => l.slice(7, -1));
    if (toasts.length) out.status = { text: toasts.join(" | ") };
    return out;
  }
  const h = /^TRANSACTION (.*?)  PROGRAM (.*?)  SCREEN ([^ ]*)(?:  SYSTEM (.*))?$/.exec(head);
  if (h) {
    put("transaction", h[1]?.split(/\s+/)[0]);
    put("program", h[2]);
    put("screen", h[3]);
    put("system", h[4]);
  }
  let window = "";
  const columns = new Map<string, string[]>();
  for (const l of lines.slice(1)) {
    if (l.startsWith("NOTE this is the SAP logon screen")) out.logon = true;
    const w = /^WINDOW (\S+)(?:  "(.*)")?/.exec(l);
    if (w) {
      window = w[1] ?? "";
      out.windows.push({ id: window, title: w[2] ?? "" });
      continue;
    }
    if (l.startsWith(" ") || !l.includes("  ")) continue;
    const [id = "", type = "", ...more] = l.split("  ");
    if (!id || !type || /\s/.test(type)) continue;
    const c = control(id, type, more.join("  "), window);
    if (type === "table") columns.set(id, c.rest.includes("columns: ") ? (c.rest.split("columns: ")[1] ?? "").split(" | ").map((x) => x.trim()) : []);
    // A table cell has no label of its own: it is its column's title and its row.
    const cell = /^(.*\/tbl[^/[]+)\/[^/]+\[(\d+),(\d+)\]$/.exec(id);
    if (cell && !c.label) {
      const title = columns.get(cell[1] ?? "")?.[Number(cell[2])];
      if (title) c.label = `${title}, row ${Number(cell[3]) + 1}`;
    }
    out.controls.push(c);
    if (type === "status" && !out.status) {
      const m = /^([A-Z]): /.exec(c.rest);
      out.status = { ...(m?.[1] ? { type: m[1] } : {}), text: c.value };
    }
  }
  // The top window is the one the user works in: the last popup, else the main window.
  const top = out.windows.filter((x) => /^wnd\[\d+\]$/.test(x.id)).at(-1) ?? out.windows.at(-1);
  if (top?.title) out.title = top.title;
  return out;
}

/**
 * A view read while the surface is still busy with a step says so in a NOTE
 * line (Web GUI: its page is locked until the answer is drawn). That screen
 * is from before the step: it must not be recorded as where the step led,
 * nor compared with the recording.
 */
export const stillWorking = (view: string): boolean => /^NOTE SAP is still working on a step/m.test(view);

/**
 * The screen once the step before it is over: read again while the view
 * says SAP is still working, for at most `maxMs`. Then the screen as it is.
 */
export async function readSettled(look: () => Promise<string>, maxMs = 15_000, pauseMs = 250): Promise<ParsedScreen> {
  const until = Date.now() + maxMs;
  let view = await look();
  while (stillWorking(view) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    view = await look();
  }
  return parseScreen(view);
}

export const refOf = (s: ParsedScreen): ScreenRef => ({
  ...(s.transaction ? { transaction: s.transaction } : {}),
  ...(s.program ? { program: s.program } : {}),
  ...(s.screen ? { screen: s.screen } : {}),
  ...(s.title ? { title: s.title } : {}),
});

const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);
/** "ctxtVBAK-VBELN" -> "VBAK-VBELN": SAP prefixes the field name with the control's type. */
const fieldName = (segment: string) => segment.replace(/^[a-z]+/, "");

export interface Located {
  control: Control;
  /** exact: the recorded id. segment: same last segment elsewhere on the screen. name: same field name, another control type. */
  by: "exact" | "segment" | "name";
}

/**
 * Finds a control by the id an action or a check names, and falls back when
 * the screen moved it. SAP ids are paths (`wnd[0]/usr/subHEADER:SAPMV45A:4021/ctxtVBAK-VBELN`):
 * the last segment names the field and survives when a subscreen or a tab
 * around it changes. A fallback only counts when exactly one control matches.
 * Labels are never used: two fields of two screens can share a label, and
 * acting on the wrong one is worse than failing.
 */
export function locate(screen: ParsedScreen, id: string): Located | undefined {
  const cs = screen.controls;
  const exact = cs.find((c) => c.id === id);
  if (exact) return { control: exact, by: "exact" };
  const tail = cs.filter((c) => c.id.endsWith(`/${id}`));
  if (tail.length === 1 && tail[0]) return { control: tail[0], by: id.startsWith("wnd[") ? "segment" : "exact" };
  const seg = lastSegment(id);
  // Toolbar buttons, menus, list labels and shells are numbered (btn[8], menu[1], lbl[1,13], shell),
  // not named: the same segment elsewhere is another control, not this one moved.
  if (!/[A-Z]/.test(seg)) return undefined;
  const same = cs.filter((c) => lastSegment(c.id) === seg);
  if (same.length === 1 && same[0]) return { control: same[0], by: "segment" };
  const name = fieldName(seg);
  if (name && /[A-Z]/.test(name)) {
    const named = cs.filter((c) => fieldName(lastSegment(c.id)) === name);
    if (named.length === 1 && named[0]) return { control: named[0], by: "name" };
  }
  return undefined;
}
