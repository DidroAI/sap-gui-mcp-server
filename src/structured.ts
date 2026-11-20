/**
 * structuredContent, for callers that are code (a script, Claude's code
 * execution), opt-in with SAP_STRUCTURED=on.
 *
 * Off by default: clients differ in what they do with an answer that has
 * both text and structuredContent (some show the model both, some only the
 * structured part), and a screen copied into JSON costs at least twice its
 * tokens. So the structured part is small (where the session is, what ran,
 * no control list), and the text stays the answer. The output schemas are
 * declared only when it is on: tools/list is the same for a given setting.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SessionInfo } from "./core/types.js";
import type { ReplayResult } from "./record/replay.js";
import { parseScreen } from "./record/screen.js";

/** SAP_STRUCTURED=on (or true, 1). */
export function structuredFromEnv(value: string | undefined): boolean {
  return /^(on|true|1)$/i.test(value ?? "");
}

const screenShape = z.object({
  transaction: z.string().optional(),
  program: z.string().optional(),
  number: z.string().optional(),
  title: z.string().optional(),
  /** The title of the popup in front, when one is open. */
  popup: z.string().optional(),
});
export type ScreenSummary = z.infer<typeof screenShape>;

/** What sap_act answers, as data. */
export const actOutput = z.object({
  ran: z.number(),
  total: z.number(),
  stopped: z.object({ why: z.string(), text: z.string() }).optional(),
  screen: screenShape,
  status: z.object({ type: z.string().optional(), text: z.string() }).optional(),
});
export type ActOutput = z.infer<typeof actOutput>;

export const sessionsOutput = z.object({
  sessions: z.array(
    z.object({
      n: z.number(),
      active: z.boolean(),
      id: z.string(),
      surface: z.string(),
      system: z.string().optional(),
      client: z.string().optional(),
      user: z.string().optional(),
      transaction: z.string().optional(),
      title: z.string().optional(),
      where: z.string(),
    }),
  ),
});

export const replayOutput = z.object({
  passed: z.boolean(),
  steps: z.array(z.object({ n: z.number(), outcome: z.string(), ms: z.number(), failures: z.array(z.string()) })),
  variables: z.record(z.string(), z.string()),
});

export const recordOutput = z.object({ recording: z.boolean(), name: z.string().optional(), steps: z.number().optional() });

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

/** Where the session is, from a view: the header, the window in front, the status bar. */
export function screenOf(view: string): { screen: ScreenSummary; status?: { type?: string; text: string } } {
  const p = parseScreen(view);
  const popups = p.windows.filter((w) => /^wnd\[[1-9]\d*\]$/.test(w.id));
  // With a popup open the header names the popup's screen; the title is the main window's.
  const screen = defined({ transaction: p.transaction, program: p.program, number: p.screen, title: p.windows[0]?.title ?? p.title, popup: popups.at(-1)?.title });
  return p.status?.text ? { screen, status: { ...(p.status.type ? { type: p.status.type } : {}), text: p.status.text } } : { screen };
}

/** Where a session is, from what the registry knows (no view read). */
export function screenOfInfo(info: SessionInfo): ScreenSummary {
  return defined({ transaction: info.transaction, title: info.title });
}

export function sessionsData(sessions: SessionInfo[], active: string | undefined) {
  return {
    sessions: sessions.map((s, i) => defined({ n: i + 1, active: s.id === active, id: s.id, surface: s.surface, system: s.system, client: s.client, user: s.user, transaction: s.transaction, title: s.title, where: s.where })),
  };
}

export function replayData(r: ReplayResult) {
  return { passed: r.passed, steps: r.steps.map((s) => ({ n: s.n, outcome: s.outcome, ms: s.ms, failures: s.failures })), variables: r.variables };
}

/** The result with its data; unchanged when there is none. */
export function withData(r: CallToolResult, data: Record<string, unknown> | undefined): CallToolResult {
  return data ? { ...r, structuredContent: data } : r;
}
