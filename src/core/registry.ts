/**
 * Sessions across surfaces: discovery, the active session, and one open
 * driver per session, checked each time it is used.
 */
import { systemAllowed, type Policy } from "./guard.js";
import type { Driver, SessionInfo, Surface, SurfaceName } from "./types.js";

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
}

export interface Attached {
  driver: Driver;
  info: SessionInfo;
}

export class Registry {
  private drivers = new Map<string, Driver>();
  private last: SessionInfo[] = [];
  private lastErrors: string[] = [];
  active: string | undefined;

  constructor(
    readonly surfaces: Surface[],
    private policy: Policy,
  ) {}

  /** Every session the surfaces find now; sessions of systems outside SAP_ALLOW_SYSTEMS are left out. */
  async discover(): Promise<Discovery> {
    const failed = new Map<string, string[]>();
    const found = (
      await Promise.all(
        this.surfaces.map((s) =>
          s.discover().catch((e: unknown) => {
            const message = (e as Error).message;
            failed.set(message, [...(failed.get(message) ?? []), s.name]);
            return [] as SessionInfo[];
          }),
        ),
      )
    ).flat();
    const errors = [...failed].map(([message, names]) => `${names.join(", ")}: ${message}`);
    const failures = [...failed.values()].reduce((n, names) => n + names.length, 0);
    const sessions = found.filter((s) => systemAllowed(this.policy, s));
    this.last = sessions;
    this.lastErrors = errors;
    // Drop drivers of sessions that are gone, or that another surface owns now.
    for (const [key, d] of this.drivers)
      if (!sessions.some((s) => keyOf(s) === key)) {
        this.drivers.delete(key);
        await d.close().catch(() => {});
      }
    if (!this.active || !sessions.some((s) => s.id === this.active)) this.active = sessions[0]?.id;
    return { sessions, hidden: found.length - sessions.length, errors, allFailed: this.surfaces.length > 0 && failures === this.surfaces.length };
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
    if (why) return new Error(`No open SAP session found.${why}`);
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
