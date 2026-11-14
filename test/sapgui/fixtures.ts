import { readFileSync } from "node:fs";
import type { Screen, SessionsFacts, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";

const file = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

export const NAMES = ["va01", "va03", "va03-texts", "va05", "se80", "f4", "ask", "easy"] as const;
export type Name = (typeof NAMES)[number];

export const screen = (name: Name): Screen => JSON.parse(file(`facts/${name}.json`)) as Screen;
export const expected = (name: Name): string => file(`expected/${name}.txt`).replace(/\n$/, "");
export const sessions = (): SessionsFacts => JSON.parse(file("facts/sessions.json")) as SessionsFacts;

/** A host that answers from the fixtures and records what it was asked. */
export function fakeHost() {
  const asked: { op: string; params: Record<string, unknown> }[] = [];
  const name = (session: unknown): Name => {
    const m = /ses\[(\d+)\]$/.exec(String(session));
    const n = NAMES[Number(m?.[1] ?? -1)];
    if (!String(session).startsWith("/app/con[0]/") || !n) throw new HostError(`NO_SESSION: session ${String(session)} is closed`);
    return n;
  };
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      asked.push({ op, params });
      if (op === "sessions") return sessions() as T;
      if (op === "screen") return screen(name(params.session)) as T;
      if (op === "info") return sessions().connections[0]?.sessions.find((s) => s.id === params.session) as T;
      if (op === "describe") {
        const menu = params.control === "wnd[0]/mbar/menu[0]/menu[1]";
        return (menu ? { found: true, control: { id: params.control, type: "GuiMenu", name: "menu[1]", text: "Save", tip: "" } } : { found: false }) as T;
      }
      if (op === "act") return { done: true } as T;
      if (op === "screenshot") return { png: Buffer.from("PNG").toString("base64") } as T;
      throw new HostError(`UNKNOWN_OP: ${op}`);
    },
    close() {},
  };
  return { host, asked };
}
