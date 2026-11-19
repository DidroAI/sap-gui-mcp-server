/**
 * Where SAP GUI draws things, in screen pixels, and which window is which
 * session: what keyboard and mouse input needs.
 *
 * Cells. SAP GUI lays a screen out on a grid of character cells. The cell's
 * pixel size depends on the theme, the font and Windows' scaling. It is
 * taken, first to last:
 *   1. SAP_DIAG_CELL="cw,ch[,x0,y0]" (a calibration by hand);
 *   2. the cell size SAP GUI reports to the server (traffic.ts `font`);
 *   3. the screen area's pixel size divided by its size in cells.
 * The offsets of the first cell (x0, y0) were measured on Quartz at 100%
 * (3 px from the area's left, the middle of row r at 27 (r + 1) - 2) and
 * are scaled with the cell size elsewhere: that scaling is a guess to
 * check on other themes (see the live checks in docs).
 *
 * Windows. The router knows connections and SAP's modes; Windows knows
 * session windows by handle and title, and SAP GUI windows of connections
 * that do not go through the router look the same. A mode's window is
 * found by its title; a window whose status bar shows another system or
 * client than the traffic is never it; then the status bar's text, and a
 * binding kept from an earlier match without doubt, tell windows of the
 * same title apart. A match is without doubt when the status bar shows the
 * mode's system and client, or the message SAP sent it, or when there are no more windows with that
 * title (minimized ones count) than routed modes that show it. Anything
 * else is refused: input never goes to a window that may not be routed.
 */

export type Rect = [number, number, number, number];

export interface Cells {
  /** Width and height of one cell, in pixels. */
  cw: number;
  ch: number;
  /** Pixel offset, from the area's left and top, of the left edge of column 0 and of the middle of row 0. */
  x0: number;
  y0: number;
  source: "env" | "traffic" | "area";
}

/** A calibration by hand: "cw,ch" or "cw,ch,x0,y0". */
export function cellsFromEnv(value: string | undefined): Cells | undefined {
  if (!value) return undefined;
  const n = value.split(",").map((x) => Number(x.trim()));
  if (n.length < 2 || n.some((x) => !Number.isFinite(x) || x < 0)) return undefined;
  const [cw, ch, x0, y0] = n as [number, number, number?, number?];
  if (cw < 3 || ch < 6) return undefined;
  return { cw, ch, x0: x0 ?? Math.round((3 * cw) / 8), y0: y0 ?? ch - Math.floor(ch / 10), source: "env" };
}

/** The cell metrics of a window's screen area: see the top of this file for the order. */
export function cellMetrics(area: Rect, size: { rows: number; cols: number }, font?: { cw: number; ch: number }, env?: Cells): Cells {
  if (env) return env;
  const [, , w, h] = area;
  const cw = font?.cw ?? Math.max(1, Math.floor(w / Math.max(1, size.cols)));
  const ch = font?.ch ?? Math.max(1, Math.floor(h / Math.max(1, size.rows + 1)));
  // Measured on Quartz at 100% (VA01, VA03): x = 3 + 8 col, the middle of row r at 27 (r + 1) - 2.
  return { cw, ch, x0: Math.round((3 * cw) / 8), y0: ch - Math.floor(ch / 10), source: font ? "traffic" : "area" };
}

/** Cell to screen pixel, on a window's screen area: inside the element, near its left part. */
export function cellPoint(area: Rect, size: { rows: number; cols: number }, row: number, col: number, width = 1, cells?: Cells): [number, number] {
  const c = cells ?? cellMetrics(area, size);
  const [left, top] = area;
  const x = left + c.x0 + c.cw * col + Math.min(Math.floor((c.cw * Math.max(1, width)) / 2), 3 * c.cw);
  const y = top + c.ch * row + c.y0;
  return [x, y];
}

/** Line height of a grid's rows and of a tree's lines, from the cell height (measured on Quartz at 100%: 26 and 24 px for a 27 px cell). */
export const gridPitch = (c: Cells): number => Math.max(12, c.ch - 1);
export const treePitch = (c: Cells): number => Math.max(12, c.ch - 3);

// ---- windows ----

/** A SAP GUI window as the input host lists it. */
export interface HostWindow {
  hwnd: number;
  kind: "session" | "popup";
  title: string;
  foreground?: boolean;
  /** Text of the status bar, when the host read it. */
  status?: string;
  /** Every text of the status bar strip (the system field among them, "ABA (1) 800"), when the host read it. */
  info?: string;
  /** Minimized: listed so that a window of the same title is not taken for it, never acted on. */
  minimized?: boolean;
}

/** What a mode's screen says about its window. */
export interface ModeFacts {
  /** "connection:mode", unique for the server's life. */
  key: string;
  title: string;
  /** Text of the status bar message, when there is one. */
  status?: string;
  /** System id and client of the mode, from the traffic. */
  system?: string;
  client?: string;
  /** Open routed modes (of every connection) whose screen has this title; 1 when not given. */
  routed?: number;
}

/** System id and client as SAP GUI's status bar shows them ("ABA (1) 800"), or undefined. */
export function systemOf(info: string | undefined): { system: string; client: string } | undefined {
  const m = /\b([A-Z][A-Z0-9]{2})\s*\(\d+\)\s*(\d{3})\b/.exec(info ?? "");
  return m ? { system: m[1] as string, client: m[2] as string } : undefined;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * The session window of a mode, or a refusal (a string) that says what to do.
 * `bound` maps a window handle to the mode key it was matched to before; it
 * is updated here. `live` says whether a mode key is still open (a binding
 * of a closed mode is dropped).
 */
export function pickWindow(windows: HostWindow[], mode: ModeFacts, bound: Map<number, string>, live: (key: string) => boolean): HostWindow | string {
  const sessions = windows.filter((w) => w.kind === "session");
  for (const [hwnd, key] of bound) if (!live(key) || !sessions.some((w) => w.hwnd === hwnd)) bound.delete(hwnd);
  const title = norm(mode.title);
  const titled = sessions.filter((w) => norm(w.title) === title);
  if (!titled.length) return `No SAP GUI window titled "${mode.title}" is open on this desktop.`;
  // A window whose status bar shows another system or client is a session that is not this one (maybe not routed at all).
  const sys = (w: HostWindow) => systemOf(w.info);
  const mismatch = (w: HostWindow) => {
    const s = sys(w);
    return !!s && ((!!mode.system && s.system !== mode.system) || (!!mode.client && s.client !== mode.client));
  };
  const cands = titled.filter((w) => !mismatch(w));
  const which = `${mode.system ? ` of system ${mode.system}` : ""}${mode.client ? ` client ${mode.client}` : ""}`;
  if (!cands.length) return `No SAP GUI window titled "${mode.title}"${which} is open on this desktop: the windows with this title show another system or client in their status bar, so they are not this session.`;
  const confirmed = (w: HostWindow) => {
    const s = sys(w);
    return !!s && !!mode.system && s.system === mode.system && (!mode.client || s.client === mode.client);
  };
  const usable = (w: HostWindow): HostWindow | string => (w.minimized ? `The SAP GUI window "${mode.title}"${which} is minimized: restore it, then ask again.` : w);
  const mine = cands.find((w) => bound.get(w.hwnd) === mode.key);
  if (mine) return usable(mine);
  // Windows another mode was matched to are not this one.
  let free = cands.filter((w) => !bound.has(w.hwnd));
  // The one window whose status bar text is the message SAP sent this mode.
  let byStatus = false;
  if (free.length > 1 && norm(mode.status)) {
    const same = free.filter((w) => w.status !== undefined && norm(w.status) === norm(mode.status));
    if (same.length) free = same;
    byStatus = same.length === 1;
  }
  const ambiguous = `Several SAP GUI windows are titled "${mode.title}" and nothing tells which one is this session${which}: one of them may be a connection that does not go through the router, so no input was sent. Close or minimize the others, or show the system and client in SAP GUI's status bar, then ask again.`;
  if (free.length !== 1) return ambiguous;
  const w = free[0] as HostWindow;
  // Without doubt: its status bar shows this system and client, or no more windows have this title than routed modes show it.
  if (!confirmed(w) && !byStatus && cands.length > Math.max(1, mode.routed ?? 1)) return ambiguous;
  bound.set(w.hwnd, mode.key);
  return usable(w);
}
