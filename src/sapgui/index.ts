/**
 * The SAP GUI for Windows surface.
 *
 * It attaches to the SAP GUI the user already has open, through SAP GUI
 * scripting, and never logs on. Scripting is COM: a PowerShell host process
 * (host.ts, ps/host.ps1) reads raw facts, and the text view is formatted
 * here (format.ts) and shortened by core/compact.ts.
 *
 * Actions: set, press, key, select, check, combo, okcode, f4, focus,
 * dblclick, tree (double, select, expand, collapse), grid (double, select)
 * and toolbar. Ids are the ones the view shows; short ids and SAP field
 * names work too (resolve.ts).
 */
import { compact } from "../core/compact.js";
import { type Action, ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { assess } from "./assess.js";
import type { Control, DoctorEngine, DoctorLocal, Screen, SessionFacts, SessionsFacts, Transport } from "./facts.js";
import { fullView } from "./format.js";
import { HostError, PsHost } from "./host.js";
import { relativeId, resolve } from "./resolve.js";

const PREFIX = "sapgui:";
/** How long a screen read may serve the step that follows it (assess, then act). */
const FRESH_MS = 1500;
/** A step in SAP can run long (a report, a large list): actions get more time than reads. */
const ACT_MS = 180_000;

export interface SapguiOptions {
  /** Default: process.platform. */
  platform?: string;
  /** Default: the PowerShell host. Tests pass a fake. */
  transport?: Transport;
}

function sessionInfo(s: SessionFacts, where: string): SessionInfo {
  const info: SessionInfo = { id: PREFIX + s.id, surface: "sapgui", where };
  if (s.system) info.system = s.system;
  if (s.client) info.client = s.client;
  if (s.user) info.user = s.user;
  if (s.transaction) info.transaction = s.transaction;
  const title = s.busy ? "(busy)" : s.windows?.[0]?.title;
  if (title) info.title = title;
  return info;
}

/** What the host's failure means for the model. */
function explain(e: unknown): Error {
  if (!(e instanceof HostError)) return e as Error;
  switch (e.code) {
    case "NO_SESSION":
      return new ActionError("This SAP GUI session is closed. Call sap_sessions to see what is open.");
    case "NO_SAPGUI":
    case "NO_ENGINE":
      return new ActionError(`${e.message}. Run "sap-gui-mcp-server doctor" for what to change.`);
    case "BUSY":
      return new ActionError("SAP GUI is still busy with the last step. Look again in a moment.");
    default:
      return new ActionError(`SAP GUI refused: ${e.message}`);
  }
}

class SapguiDriver implements Driver {
  info: SessionInfo;
  private sid: string;
  private last: { at: number; screen: Screen } | undefined;

  constructor(
    info: SessionInfo,
    private host: Transport,
  ) {
    this.info = info;
    this.sid = info.id.slice(PREFIX.length);
  }

  private async ask<T>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    try {
      return await this.host.request<T>(op, { session: this.sid, ...params }, timeoutMs);
    } catch (e) {
      throw explain(e);
    }
  }

  private async screen(reuse = false): Promise<Screen> {
    if (reuse && this.last && Date.now() - this.last.at < FRESH_MS) return this.last.screen;
    const screen = await this.ask<Screen>("screen");
    this.last = { at: Date.now(), screen };
    return screen;
  }

  async refresh(): Promise<SessionInfo> {
    this.info = sessionInfo(await this.ask<SessionFacts>("info"), this.info.where);
    return this.info;
  }

  async look(options: LookOptions): Promise<string> {
    const full = fullView(await this.screen());
    return options.compact ? compact(full) : full;
  }

  /** The control an action's id means: on the screen read, or asked from SAP GUI (menu entries are not in the read). */
  private async target(screen: Screen, action: Action): Promise<Control | undefined> {
    if (typeof action.id !== "string" || !action.id.trim()) return undefined;
    const found = resolve(screen, action.id);
    if (found) return found;
    const id = relativeId(action.id);
    if (!id.startsWith("wnd[")) return undefined;
    const r = await this.ask<{ found: boolean; control?: Control }>("describe", { control: id });
    return r.found ? r.control : undefined;
  }

  async assess(action: Action): Promise<Assessment> {
    const screen = await this.screen();
    return assess(screen, action, await this.target(screen, action));
  }

  async act(action: Action): Promise<string> {
    const doing = action.do;
    if (doing === "okcode") {
      if (typeof action.value !== "string") throw new ActionError('okcode needs "value", e.g. {"do":"okcode","value":"/nVA03"}');
      return this.run({ do: "okcode", value: action.value }, `okcode ${action.value}`);
    }
    if (doing === "key") {
      const key = Number(action.key ?? action.value);
      if (!Number.isInteger(key) || key < 0 || key > 99) throw new ActionError('key needs "key", a virtual key number: 0 Enter, 3 Back, 4 F4, 8 F8, 12 Cancel');
      return this.run({ do: "key", key }, `key ${key}`);
    }
    if (typeof action.id !== "string" || !action.id.trim()) throw new ActionError(`${doing} needs "id": a control id from sap_look`);
    const screen = await this.screen(true);
    const target = await this.target(screen, action);
    if (!target) throw new ActionError(`No control "${action.id}" on this screen. Use an id from sap_look (the screen may have changed).`);
    const id = target.id;
    switch (doing) {
      case "set":
        return this.run({ do: "set", id, value: String(action.value ?? "") }, `set ${id} = "${String(action.value ?? "")}"`);
      case "press":
      case "focus":
      case "f4":
      case "select":
        return this.run({ do: doing, id }, `${doing} ${id}`);
      case "check": {
        const value = action.value === undefined ? true : action.value === true || action.value === "true" || action.value === "x" || action.value === "X" || action.value === 1;
        return this.run({ do: "check", id, value }, `${value ? "checked" : "unchecked"} ${id}`);
      }
      case "combo": {
        // By key, or by the text the dropdown shows.
        const wanted = String(action.key ?? action.value ?? "");
        const entries = target.entries ?? [];
        const key = entries.find(([k]) => k === wanted) ?? entries.find(([k]) => k.trim() === wanted.trim()) ?? entries.find(([, v]) => v.trim().toLowerCase() === wanted.trim().toLowerCase());
        if (entries.length && !key) throw new ActionError(`No entry "${wanted}" in ${id}. Entries: ${entries.map(([k, v]) => `${k.trim()}:${v.trim()}`).join(", ")}`);
        return this.run({ do: "combo", id, key: key?.[0] ?? wanted }, `combo ${id} = "${(key?.[0] ?? wanted).trim()}"`);
      }
      case "dblclick":
        if (action.node !== undefined) return this.act({ ...action, do: "tree", how: "double" });
        if (action.row !== undefined) return this.act({ ...action, do: "grid", how: "double" });
        return this.run({ do: "dblclick", id }, `double-click ${id}`);
      case "tree": {
        if (action.node === undefined) throw new ActionError('tree needs "node": the key shown as {node <key>}');
        const how = action.how ?? "double";
        if (!["double", "select", "expand", "collapse"].includes(how)) throw new ActionError('tree "how" is double, select, expand or collapse');
        return this.run({ do: "tree", id, node: String(action.node), how, ...(action.col ? { col: action.col } : {}) }, `tree ${how} node ${String(action.node).trim()} in ${id}`);
      }
      case "grid": {
        if (!Number.isInteger(action.row) || typeof action.col !== "string") throw new ActionError('grid needs "row" (number, from "row N:") and "col" (column id, e.g. "VBELN")');
        const how = action.how ?? "double";
        if (!["double", "select"].includes(how)) throw new ActionError('grid "how" is double or select');
        return this.run({ do: "grid", id, row: action.row, col: action.col, how }, `grid ${how} row ${action.row}, column ${action.col} in ${id}`);
      }
      case "toolbar":
        if (typeof action.button !== "string") throw new ActionError('toolbar needs "button": the id shown as {<id>}');
        return this.run({ do: "toolbar", id, button: action.button }, `toolbar button ${action.button} in ${id}`);
      default:
        throw new ActionError(`Unknown action "${doing}". SAP GUI takes: set, press, key, select, check, combo, okcode, f4, focus, dblclick, tree, grid, toolbar.`);
    }
  }

  private async run(action: Record<string, unknown>, note: string): Promise<string> {
    this.last = undefined;
    await this.ask("act", { action }, ACT_MS);
    return note;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.ask<{ png: string }>("screenshot");
    return Buffer.from(r.png, "base64");
  }

  async close(): Promise<void> {
    // The host is shared by every session of the surface and stops with the server.
  }
}

const OPTIONS = 'SAP Logon > Options > Accessibility & Scripting > Scripting';

function setting(local: DoctorLocal, name: string): { value: number | undefined; where: string } {
  const s = local.settings[name];
  return { value: s?.value, where: s ? (s.where === "HKLM" ? " (set for the whole machine by an administrator)" : "") : " (not set: SAP GUI's default)" };
}

export async function doctor(host: Transport): Promise<{ ok: boolean; check: string; detail: string }[]> {
  const out: { ok: boolean; check: string; detail: string }[] = [];
  let local: DoctorLocal;
  try {
    local = await host.request<DoctorLocal>("doctor-local", {}, 30_000);
  } catch (e) {
    return [{ ok: false, check: "PowerShell host", detail: `${(e as Error).message}. The server talks to SAP GUI through Windows PowerShell 5.1 (powershell.exe); it must be allowed to run.` }];
  }
  const running = local.processes.length > 0;
  out.push({
    ok: running,
    check: "SAP GUI is running",
    detail: running ? local.processes.join(", ") : "not running: start SAP Logon and log on to a system",
  });

  const scripting = setting(local, "UserScripting");
  const attach = setting(local, "WarnOnAttach");
  const connection = setting(local, "WarnOnConnection");

  let engine: DoctorEngine | undefined;
  let engineError = "";
  if (running) {
    try {
      engine = await host.request<DoctorEngine>("doctor-engine", {}, 30_000);
    } catch (e) {
      engineError = (e as Error).message;
    }
  }
  const clientOn = scripting.value !== 0 && (!running || engine?.engine === true);
  out.push({
    ok: clientOn,
    check: "Scripting is on in SAP GUI",
    detail:
      scripting.value === 0
        ? `off${scripting.where}: tick "Enable scripting" in ${OPTIONS}, then restart SAP Logon`
        : !running
          ? `on${scripting.where}; not checked against SAP GUI, which is not running`
          : engine?.engine
            ? `on${scripting.where}`
            : `SAP GUI does not offer its scripting object (${engineError || engine?.error || "no reason given"}): tick "Enable scripting" in ${OPTIONS}, restart SAP Logon, and run this server as the same Windows user, in the same desktop session, not as administrator`,
  });

  const cons = engine?.connections ?? [];
  const visible = cons.reduce((n, c) => n + c.sessions, 0);
  const blocked = cons.filter((c) => c.disabledByServer || c.sessions === 0);
  out.push({
    ok: visible > 0 && blocked.length === 0,
    check: "Scripting is allowed on the SAP system",
    detail: !engine?.engine
      ? "not checked: SAP GUI scripting is not reachable"
      : !cons.length
        ? "no SAP system is logged on: log on in SAP Logon"
        : blocked.length
          ? `${blocked.map((c) => c.description || "a connection").join(", ")}: no session is visible to scripting. Set profile parameter sapgui/user_scripting = TRUE on that system (transaction RZ11, and the default profile to keep it), then log on again`
          : `${visible} session(s) on ${cons.map((c) => c.description || "a connection").join(", ")}`,
  });

  const notice = (s: { value: number | undefined; where: string }, check: string, box: string) =>
    out.push({
      ok: s.value === 0,
      check,
      detail: s.value === 0 ? `off${s.where}` : `on${s.where}: SAP GUI then shows a dialog and waits for a click each time. Untick "${box}" in ${OPTIONS}`,
    });
  notice(attach, 'Notice "a script is attaching" is off', "Notify when a script attaches to SAP GUI");
  notice(connection, 'Notice "a script opens a connection" is off', "Notify when a script opens a connection");
  return out;
}

export function sapguiSurface(env: Record<string, string | undefined>, options: SapguiOptions = {}): Surface {
  const windows = (options.platform ?? process.platform) === "win32";
  let host = options.transport;
  const transport = (): Transport => (host ??= new PsHost(env));
  return {
    name: "sapgui",
    async discover() {
      if (!windows) return [];
      let facts: SessionsFacts;
      try {
        facts = await transport().request<SessionsFacts>("sessions", {}, 30_000);
      } catch (e) {
        // No SAP GUI open is not an error: the user may only work in a browser.
        if (e instanceof HostError && (e.code === "NO_SAPGUI" || e.code === "NO_ENGINE")) return [];
        throw e;
      }
      const out: SessionInfo[] = [];
      for (const con of facts.connections)
        con.sessions.forEach((s, i) => {
          const n = s.sessionNumber || i + 1;
          out.push(sessionInfo(s, `SAP GUI ${con.description || con.id}, session ${n}`));
        });
      // The session the user is in comes first: the registry makes the first one active.
      const active = PREFIX + facts.active;
      return [...out.filter((s) => s.id === active), ...out.filter((s) => s.id !== active)];
    },
    async open(session) {
      if (!windows) throw new Error("SAP GUI for Windows needs Windows.");
      return new SapguiDriver(session, transport());
    },
    async doctor() {
      if (!windows)
        return [{ ok: false, check: "SAP GUI for Windows", detail: "needs Windows: run the server on the Windows machine where SAP GUI is open (Web GUI and Fiori work everywhere)" }];
      return doctor(transport());
    },
  };
}
