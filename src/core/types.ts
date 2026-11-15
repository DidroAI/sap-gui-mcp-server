/**
 * The contract every SAP surface implements. A surface (SAP GUI for Windows,
 * Web GUI, Fiori) discovers the sessions the user already has open, and a
 * driver reads and acts on one of them. The MCP server only talks to these
 * types, so a new surface (or a second method for one, e.g. SAP GUI without
 * scripting) plugs in without touching the server.
 */

export type SurfaceName = "sapgui" | "webgui" | "fiori";

/** One SAP session the user has open, as discovery found it. */
export interface SessionInfo {
  /** Stable for the life of the session, e.g. "sapgui:ses[0]" or "chrome:<targetId>". */
  id: string;
  surface: SurfaceName;
  /** SAP system id, e.g. "ABA". */
  system?: string;
  client?: string;
  user?: string;
  /** Transaction code shown on screen, e.g. "VA03". */
  transaction?: string;
  /** Window or tab title. */
  title?: string;
  /** Where it lives: "SAP GUI connection 0", "Chrome tab 'Display Sales Order'", ... */
  where: string;
  /** For browser tabs: the URL without query string or fragment. */
  url?: string;
}

/**
 * One action. The vocabulary follows SAP GUI scripting, so an agent learns one
 * set for every surface (each surface documents the subset it supports):
 *
 *   {"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}   type into a field
 *   {"do": "press", "id": "btn[8]"}                         push a button
 *   {"do": "key", "key": 0}                                 virtual key: 0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel
 *   {"do": "select", "id": "tabpT\\08"}                     tab, radio button, menu entry
 *   {"do": "check", "id": "...", "value": true}             checkbox
 *   {"do": "combo", "id": "...", "key": "PROG"}             dropdown entry (key or shown text); without a key: lists the entries
 *   {"do": "okcode", "value": "/nVA03"}                     command field
 *   {"do": "f4", "id": "..."}                               value help on a field
 *   {"do": "dblclick", "id": "..."}                         list entry or label
 *   {"do": "tree", "id": "...", "node": "<key>", "how": "double|select|expand"}
 *   {"do": "grid", "id": "...", "row": 0, "col": "VBELN", "how": "double|select"}
 *   {"do": "toolbar", "id": "...", "button": "<button id>"}
 *   {"do": "scroll", "id": "...", "to": 120}                grid, table control, tree or list: to a row (from 0), "next", "prev", "first" or "last"
 *   {"do": "click", "id": "..."}                            Fiori: any control by UI5 id tail
 */
export interface Action {
  do: string;
  id?: string;
  value?: unknown;
  key?: unknown;
  node?: string;
  how?: string;
  row?: number;
  col?: string;
  button?: string;
  /** scroll: a row counted from 0, or "next", "prev", "first", "last". */
  to?: number | string;
  [k: string]: unknown;
}

/**
 * What an action may do to the system, from least to most:
 * - read: changes nothing (focus, value help, expand a tree node);
 * - navigate: moves between screens or changes unsaved input (set, Enter, tabs, Back);
 * - commit: saves, posts, deletes, releases or otherwise writes to the database.
 * A surface returns "commit" whenever it cannot rule it out.
 */
export type Risk = "read" | "navigate" | "commit";

export interface Assessment {
  risk: Risk;
  /** Why, in a few words a user can confirm: 'button "Save (Ctrl+S)"', "okcode /11". */
  reason: string;
}

export interface LookOptions {
  /** Compact view (default) or the full view with every id and column. */
  compact: boolean;
  /**
   * Only this control, whole: every row the reader holds and every entry of
   * a dropdown, whatever the compact view leaves out. `id` is an id or a
   * handle from the view.
   */
  id?: string;
  /**
   * With `id`, for a grid, a table control, a tree or a list: these rows
   * (first and last, counted from 0), read by scrolling the control. The
   * control stays scrolled to the last rows read.
   */
  rows?: { from: number; to: number };
}

/** A live connection to one session. */
export interface Driver {
  readonly info: SessionInfo;
  /** Fresh header facts (system, transaction, title) for guardrails and session lists. */
  refresh(): Promise<SessionInfo>;
  /**
   * Is this driver still on the session it was opened for? False when the tab
   * was closed, the browser connection dropped, or the tab now shows something
   * another surface owns: the registry then drops the driver and opens a new
   * one. A driver without it is checked by `refresh` alone.
   */
  valid?(): Promise<boolean>;
  /** The screen as text: a header line, then one line per control. */
  look(options: LookOptions): Promise<string>;
  /** Classify an action before it runs, from the current screen. The action is normalised (core/action.ts). */
  assess(action: Action): Promise<Assessment>;
  /** Run one action, the same normalised object `assess` saw; returns a one-line note of what was done. Throws ActionError when it cannot. */
  act(action: Action): Promise<string>;
  /** Where the time of the last `act` went, as one line ("1306 ms: sap 812, start 40, ..."); surfaces that do not measure have none. */
  timing?(): string | undefined;
  /** PNG of the session's window or tab. */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

/** One setup check: a short name, what was found, and (when not ok) the one thing to do. */
export interface DoctorCheck {
  ok: boolean;
  check: string;
  detail: string;
  fix?: string;
}

/** A surface finds sessions and opens drivers on them. */
export interface Surface {
  readonly name: SurfaceName;
  /** Sessions open right now. Never logs on and never opens anything. */
  discover(): Promise<SessionInfo[]>;
  open(session: SessionInfo): Promise<Driver>;
  /** Setup checks for `doctor`: one each, ok or not, what was found, and what to change when not ok. */
  doctor(): Promise<DoctorCheck[]>;
}

/** An action that could not run: the message is meant for the model. */
export class ActionError extends Error {
  override name = "ActionError";
}
