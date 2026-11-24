/**
 * Sessions across surfaces: discovery, the active session, and one open
 * driver per session, checked each time it is used.
 */
import { systemAllowed, type Policy } from "./guard.js";
import { type Driver, NotOpenYet, type SessionInfo, type Surface, type SurfaceName } from "./types.js";

const SURFACE_NAMES: readonly string[] = ["sapgui", "webgui", "fiori"] satisfies SurfaceName[];

/** A Web GUI tab and a Fiori tab can carry the same id (the Chrome target): the surface is part of the key. */
const keyOf = (s: Pick<SessionInfo, "surface" | "id">) => `${s.surface}|${s.id}`;

const outside = (s: SessionInfo) => `System ${s.system ?? "(unknown)"}${s.client ? `/${s.client}` : ""} is outside SAP_ALLOW_SYSTEMS.`;

export interface Discovery {
  sessions: SessionInfo[];
  hidden: number;
  /** One line per failure; surfaces that failed the same way share a line ("webgui, fiori: ..."). */
  errors: string[];
  /** Did every surface fail? */
  allFailed: boolean;
  /** With no session found: what a surface says the user has to do (the SAP window is open, log on there). */
  hint?: string;
}

export interface Attached {
  driver: Driver;
  info: SessionInfo;
}

export class Registry {
  private drivers = new Map<string, Driver>();
  private last: SessionInfo[] = [];
  private lastErrors: string[] = [];
  private lastHint: string | undefined;
  /** The surface of every session id seen since the server started: a session that closed is still known by it. */
  private surfaces_ = new Map<string, SurfaceName>();
  active: string | undefined;

  constructor(
    readonly surfaces: Surface[],
    private policy: Policy,
  ) {}

  /** Every session the surfaces find now; sessions of systems outside SAP_ALLOW_SYSTEMS are left out. */
  async discover(): Promise<Discovery> {
    const failed = new Map<string, string[]>();
    /** Surfaces that would have to open their browser window first. */
    const closed: Surface[] = [];
    const ask = (surfaces: Surface[], quiet: boolean) =>
      Promise.all(
        surfaces.map((s) =>
          s.discover({ quiet }).catch((e: unknown) => {
            if (quiet && e instanceof NotOpenYet) closed.push(s);
            else {
              const message = (e as Error).message;
              failed.set(message, [...(failed.get(message) ?? []), s.name]);
            }
            return [] as SessionInfo[];
          }),
        ),
      );
    let found = (await ask(this.surfaces, true)).flat();
    // Nothing is open anywhere: now the SAP window is opened, for the user to log on in.
    if (!found.length && closed.length) found = (await ask(closed, false)).flat();
    const errors = [...failed].map(([message, names]) => `${names.join(", ")}: ${message}`);
    const failures = [...failed.values()].reduce((n, names) => n + names.length, 0);
    const sessions = found.filter((s) => systemAllowed(this.policy, s));
    for (const s of sessions) this.surfaces_.set(s.id.toLowerCase(), s.surface);
    this.last = sessions;
    this.lastErrors = errors;
    this.lastHint = sessions.length || found.length ? undefined : this.surfaces.map((s) => s.whenEmpty?.()).find(Boolean);
    // A surface that failed this time says nothing about its sessions: they may still be open.
    const unread = new Set<string>([...failed.values()].flat());
    // Drop drivers of sessions that are gone, or that another surface owns now.
    for (const [key, d] of this.drivers)
      if (!unread.has(key.split("|", 1)[0] ?? "") && !sessions.some((s) => keyOf(s) === key)) {
        this.drivers.delete(key);
        await d.close().catch(() => {});
      }
    // The active session moves only when it is gone, never because its surface failed once: the next action
    // without a session named would run in another session, maybe on another system.
    const activeUnread = !!this.active && unread.has(this.surfaces_.get(this.active.toLowerCase()) ?? "");
    if (!activeUnread && (!this.active || !sessions.some((s) => s.id === this.active))) this.active = sessions[0]?.id;
    return { sessions, hidden: found.length - sessions.length, errors, allFailed: this.surfaces.length > 0 && failures === this.surfaces.length, ...(this.lastHint ? { hint: this.lastHint } : {}) };
  }

  /**
   * Find a session by a list number from sap_sessions, its id, where it lives,
   * a surface name ("fiori": the active session if it is one, else the first),
   * or a loose reference ("ABA", "VA03", part of a title).
   */
  resolve(ref: string): SessionInfo | undefined {
    const r = ref.trim().toLowerCase();
    if (!r) return undefined;
    const n = /^\d+$/.test(r) ? Number(r) : undefined;
    if (n !== undefined && this.last[n - 1]) return this.last[n - 1];
    const exact = this.last.find((s) => s.id.toLowerCase() === r) ?? this.last.find((s) => s.where.toLowerCase() === r);
    if (exact) return exact;
    if (SURFACE_NAMES.includes(r)) {
      const of = this.last.filter((s) => s.surface === r);
      return of.find((s) => s.id === this.active) ?? of[0];
    }
    return this.last.find((s) => [s.system, s.transaction, s.title, s.where].some((x) => x?.toLowerCase().includes(r)));
  }

  /**
   * A session id that names no open session any more (its tab closed or was opened again under another id,
   * "chrome:<old id>"), when exactly one session of its surface is open now: that one. Undefined otherwise,
   * also for a reference that is not a session id. Discovers first.
   */
  async replacement(ref: string): Promise<SessionInfo | undefined> {
    const r = ref.trim().toLowerCase();
    if (!r) return undefined;
    await this.discover().catch(() => undefined);
    if (this.resolve(ref)) return undefined;
    const surface = this.surfaces_.get(r) ?? (SURFACE_NAMES.includes(r.split(":", 1)[0] ?? "") ? (r.split(":", 1)[0] as SurfaceName) : undefined);
    const chrome = r.startsWith("chrome:");
    if (!surface && !chrome) return undefined;
    const same = this.last.filter((s) => (surface ? s.surface === surface : s.id.toLowerCase().startsWith("chrome:")));
    return same.length === 1 ? same[0] : undefined;
  }

  private find(ref: string | undefined): SessionInfo | undefined {
    return ref ? this.resolve(ref) : this.last.find((s) => s.id === this.active);
  }

  private async drop(info: SessionInfo): Promise<void> {
    const key = keyOf(info);
    const d = this.drivers.get(key);
    this.drivers.delete(key);
    await d?.close().catch(() => {});
  }

  private notFound(ref: string | undefined): Error {
    const why = this.lastErrors.length ? ` Discovery failed: ${this.lastErrors.join(" | ")}` : "";
    if (ref) return new Error(`No open SAP session matches "${ref}". Call sap_sessions to list them.${why}`);
    if (this.active && this.last.length) return new Error(`The active session ${this.active} could not be read now; no other session is used in its place. Try again, or name a session (sap_sessions lists them).${why}`);
    if (why) return new Error(`No open SAP session found.${why}`);
    if (this.lastHint) return new Error(`No open SAP session found. ${this.lastHint}`);
    return new Error("No open SAP session found. Open SAP GUI, or a Web GUI or Fiori tab in Chrome (see sap_sessions for how the server finds them).");
  }

  /** A driver that is still on its session, with the session's facts as they are now; or why there is none. */
  private async attach(info: SessionInfo): Promise<Attached | { stale: Error | undefined }> {
    const key = keyOf(info);
    let d = this.drivers.get(key);
    if (d?.valid && !(await d.valid().catch(() => false))) {
      await this.drop(info);
      return { stale: undefined };
    }
    try {
      if (!d) {
        const surface = this.surfaces.find((s) => s.name === info.surface);
        if (!surface) throw new Error(`No surface ${info.surface}`);
        d = await surface.open(info);
        this.drivers.set(key, d);
      }
      return { driver: d, info: await d.refresh() };
    } catch (e) {
      await this.drop(info);
      return { stale: e as Error };
    }
  }

  /**
   * The driver for a session reference, or for the active session, and the
   * session's fresh facts. Discovers when needed. A cached driver whose tab
   * closed, whose browser connection dropped, or whose tab moved to another
   * surface is dropped; the session is then found and opened again, once.
   * Refuses a session whose system is outside SAP_ALLOW_SYSTEMS: every tool
   * that touches a session comes through here.
   */
  async session(ref?: string): Promise<Attached> {
    if (!this.last.length || !this.find(ref)) await this.discover();
    let info = this.find(ref);
    if (!info) throw this.notFound(ref);
    let hit = await this.attach(info);
    if ("stale" in hit) {
      // What we knew is stale: look again, and follow the session to the surface that owns it now.
      const { id } = info;
      const first = hit.stale;
      await this.discover();
      info = this.last.find((s) => s.id === id) ?? (ref ? this.find(ref) : undefined);
      if (!info) throw first ?? this.notFound(ref ?? id);
      hit = await this.attach(info);
      if ("stale" in hit) throw hit.stale ?? first ?? this.notFound(ref ?? id);
    }
    if (!systemAllowed(this.policy, hit.info)) throw new Error(outside(hit.info));
    return hit;
  }

  /** As `session`, the driver only. */
  async driver(ref?: string): Promise<Driver> {
    return (await this.session(ref)).driver;
  }

  async closeAll(): Promise<void> {
    for (const d of this.drivers.values()) await d.close().catch(() => {});
    this.drivers.clear();
  }
}
