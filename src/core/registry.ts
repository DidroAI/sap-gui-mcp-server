/**
 * Sessions across surfaces: discovery, the active session, and one open
 * driver per session (kept until the session disappears).
 */
import { systemAllowed, type Policy } from "./guard.js";
import type { Driver, SessionInfo, Surface } from "./types.js";

export class Registry {
  private drivers = new Map<string, Driver>();
  private last: SessionInfo[] = [];
  active: string | undefined;

  constructor(
    readonly surfaces: Surface[],
    private policy: Policy,
  ) {}

  /** Every session the surfaces find now; sessions of systems outside SAP_ALLOW_SYSTEMS are left out. */
  async discover(): Promise<{ sessions: SessionInfo[]; hidden: number; errors: string[] }> {
    const errors: string[] = [];
    const found = (
      await Promise.all(
        this.surfaces.map((s) =>
          s.discover().catch((e: unknown) => {
            errors.push(`${s.name}: ${(e as Error).message}`);
            return [] as SessionInfo[];
          }),
        ),
      )
    ).flat();
    const sessions = found.filter((s) => systemAllowed(this.policy, s));
    this.last = sessions;
    // Drop drivers of sessions that are gone.
    for (const [id, d] of this.drivers)
      if (!sessions.some((s) => s.id === id)) {
        this.drivers.delete(id);
        await d.close().catch(() => {});
      }
    if (!this.active || !sessions.some((s) => s.id === this.active)) this.active = sessions[0]?.id;
    return { sessions, hidden: found.length - sessions.length, errors };
  }

  /** Find a session by id, or by a loose reference ("tab 3", "ABA", "VA03", a list number from sap_sessions). */
  resolve(ref: string): SessionInfo | undefined {
    const r = ref.trim().toLowerCase();
    const n = /^\d+$/.test(r) ? Number(r) : undefined;
    if (n !== undefined && this.last[n - 1]) return this.last[n - 1];
    return (
      this.last.find((s) => s.id.toLowerCase() === r) ??
      this.last.find((s) => s.where.toLowerCase() === r) ??
      this.last.find((s) => [s.system, s.transaction, s.title, s.where].some((x) => x?.toLowerCase().includes(r)))
    );
  }

  /** The driver for a session reference, or for the active session. Discovers when needed. */
  async driver(ref?: string): Promise<Driver> {
    if (!this.last.length || (ref && !this.resolve(ref))) await this.discover();
    const info = ref ? this.resolve(ref) : this.last.find((s) => s.id === this.active);
    if (!info)
      throw new Error(
        ref
          ? `No open SAP session matches "${ref}". Call sap_sessions to list them.`
          : "No open SAP session found. Open SAP GUI, or a Web GUI or Fiori tab in Chrome (see sap_sessions for how the server finds them).",
      );
    let d = this.drivers.get(info.id);
    if (!d) {
      const surface = this.surfaces.find((s) => s.name === info.surface);
      if (!surface) throw new Error(`No surface ${info.surface}`);
      d = await surface.open(info);
      this.drivers.set(info.id, d);
    }
    return d;
  }

  async closeAll(): Promise<void> {
    for (const d of this.drivers.values()) await d.close().catch(() => {});
    this.drivers.clear();
  }
}
