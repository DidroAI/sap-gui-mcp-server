/** Fakes for the server and registry tests: a surface with sessions in memory, no SAP and no browser. */
import type { Action, Assessment, Driver, LookOptions, SessionInfo, Surface, SurfaceName } from "../src/core/types.js";

export interface FakeSession {
  info: SessionInfo;
  /** What `assess` answers; default: navigate. */
  assess?: (a: Action) => Assessment;
  /** What `act` does to the session (e.g. change the transaction). */
  onAct?: (a: Action, s: FakeSession) => void;
  /** Set to false to make the driver say it is no longer on its session. */
  valid?: boolean;
  /** Set to make `refresh` fail. */
  broken?: string;
  /** The compact view `look` answers with; default: one line naming the transaction. */
  view?: string;
  /** What `act` throws, to play an action that cannot run. */
  failAct?: Error;
  /** How long `act` takes, in milliseconds. */
  actMs?: number;
  /** What `timing` answers. */
  timing?: string;
  /** The user's notation the driver reads from the settings; none: the driver has no `notation`. */
  notation?: { sign?: "," | "."; spaced?: boolean; date?: string };
}

export class FakeSurface implements Surface {
  sessions: FakeSession[] = [];
  opened = 0;
  discovered = 0;
  failWith: string | undefined;
  /** Every call the drivers received, in order. */
  log: { op: "assess" | "act" | "act-end" | "look" | "screenshot"; action?: Action; options?: LookOptions }[] = [];

  constructor(readonly name: SurfaceName) {}

  add(info: Partial<SessionInfo> & { id: string }, more: Omit<FakeSession, "info"> = {}): FakeSession {
    const s: FakeSession = { info: { surface: this.name, where: `fake ${info.id}`, ...info }, ...more };
    this.sessions.push(s);
    return s;
  }

  async discover(): Promise<SessionInfo[]> {
    this.discovered++;
    if (this.failWith) throw new Error(this.failWith);
    return this.sessions.map((s) => ({ ...s.info }));
  }

  async open(session: SessionInfo): Promise<Driver> {
    const s = this.sessions.find((x) => x.info.id === session.id);
    if (!s) throw new Error(`${session.id} is not open any more`);
    this.opened++;
    const log = this.log;
    // The driver holds the session object it was opened on, as a real driver holds its page.
    const driver: Driver = {
      info: { ...s.info },
      refresh: async () => {
        if (s.broken) throw new Error(s.broken);
        return { ...s.info };
      },
      valid: async () => s.valid !== false && this.sessions.includes(s),
      look: async (options) => {
        // The plain compact look is what every test before the look options counted: it stays without options.
        log.push(options.compact && !options.id ? { op: "look" } : { op: "look", options });
        if (options.id) return `ONE ${options.id}${options.rows ? ` rows ${options.rows.from}-${options.rows.to}` : ""}`;
        if (!options.compact) return `FULL ${s.view ?? s.info.transaction ?? ""}`;
        return s.view ?? `SCREEN ${s.info.transaction ?? ""}`;
      },
      assess: async (a) => {
        log.push({ op: "assess", action: a });
        return s.assess?.(a) ?? { risk: "navigate", reason: a.do };
      },
      act: async (a) => {
        log.push({ op: "act", action: a });
        if (s.actMs) {
          await new Promise((r) => setTimeout(r, s.actMs));
          log.push({ op: "act-end", action: a });
        }
        if (s.failAct) throw s.failAct;
        s.onAct?.(a, s);
        return `did ${a.do}`;
      },
      ...(s.timing ? { timing: () => s.timing } : {}),
      ...(s.notation ? { notation: async () => s.notation } : {}),
      screenshot: async () => {
        log.push({ op: "screenshot" });
        return Buffer.from("png");
      },
      close: async () => {},
    };
    return driver;
  }

  async doctor() {
    return [];
  }

  acts(): Action[] {
    return this.log.filter((l) => l.op === "act").map((l) => l.action!);
  }
}
