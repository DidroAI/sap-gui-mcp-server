/**
 * A DIAG driver with a fake decoder, traffic and input host, for tests of what the driver sends:
 * the screen is given (and changed with `show`), every request to the input host is logged.
 */
import type { DiagElement, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { DiagDriver } from "../../src/sapgui-diag/index.js";
import { Traffic } from "../../src/sapgui-diag/traffic.js";

export const AREA: [number, number, number, number] = [8, 128, 1264, 571];

export interface Fake {
  d: DiagDriver;
  log: Record<string, unknown>[];
  traffic: Traffic;
  show(s: DiagScreen): void;
}

export function fakeDriver(s: DiagScreen, entries: { key: string; value: string }[] = [], hostTitle?: string): Fake {
  let current = s;
  const traffic = new Traffic();
  const conn = { n: 0, target: { host: "h", service: "3200" }, decoder: { screen: () => current, screens: () => new Map([[0, current]]) }, open: true, traffic, steps: new Map(), typed: new Map() };
  const log: Record<string, unknown>[] = [];
  const host = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      log.push({ op, ...params });
      const title = hostTitle ?? current.windows[0]?.title ?? "";
      if (op === "windows") return { windows: [{ hwnd: 1, kind: "session", title, foreground: true }] } as T;
      if (op === "area") return { windows: [{ hwnd: 1, kind: "session", title, area: AREA, controls: [] }] } as T;
      if (op === "valueset") return { entries } as T;
      return {} as T;
    },
    close() {},
  };
  const d = new DiagDriver({ id: "sapgui:diag:0:0", surface: "sapgui" } as never, conn as never, 0, host as never, { bound: new Map(), live: () => true, env: { SAP_DIAG_REQUEST_MS: "50" } });
  return { d, log, traffic, show: (x) => (current = x) };
}

/** The inputs sent to SAP GUI, by their kind ("set", "click", "vk", "combo"...). */
export const sent = (f: Fake) => f.log.filter((x) => x.op === "act").map((x) => (x.action as { do: string }).do);

export const cell = (column: number, text: string, kind: DiagElement["kind"] = "field", input = true) => ({ column, text, kind, input, hidden: false, ...(kind === "dropdown" ? { key: text, valueList: "0123456789ABCDEF0123456789ABCDEF" } : {}) });

export function win(over: Partial<DiagWindow> = {}): DiagWindow {
  return { index: 0, modal: false, title: "Synthetic", program: "SAPMF05A", dynpro: "1001", guiStatus: "", guiStatusProgram: "", size: { rows: 20, cols: 156 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [], controls: [], containers: [], ...over } as DiagWindow;
}

export const screen = (windows: DiagWindow[]): DiagScreen => ({ mode: 0, step: 1, session: { system: "XYZ", client: "100", user: "U", language: "E" }, windows }) as DiagScreen;

export type { DiagTable };
