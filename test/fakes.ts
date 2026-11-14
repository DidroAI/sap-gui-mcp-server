/** Fakes for the server and registry tests: a surface with sessions in memory, no SAP and no browser. */
import type { Action, Assessment, Driver, SessionInfo, Surface, SurfaceName } from "../src/core/types.js";

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
}

export class FakeSurface implements Surface {
  sessions: FakeSession[] = [];
  opened = 0;
  discovered = 0;
  failWith: string | undefined;
  /** Every call the drivers received, in order. */
  log: { op: "assess" | "act" | "look" | "screenshot"; action?: Action }[] = [];

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
      look: async () => {
        log.push({ op: "look" });
        return `SCREEN ${s.info.transaction ?? ""}`;
      },
      assess: async (a) => {
        log.push({ op: "assess", action: a });
        return s.assess?.(a) ?? { risk: "navigate", reason: a.do };
      },
      act: async (a) => {
        log.push({ op: "act", action: a });
        s.onAct?.(a, s);
        return `did ${a.do}`;
      },
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
