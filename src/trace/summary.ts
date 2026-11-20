/**
 * Step timings of a trace (or any recording that kept them), for a summary
 * line and for spotting a step that got slower from one run to the next.
 *
 *   timings(t)  [{ step: 1, action: 'await sap.okcode("/nVA03");', ms: 420, screen: "VA03 SAPMV45A/0102" }, ...]
 *
 * One entry per step, in order; `ms` is null when the step kept no time
 * (recordings made before timings were kept). Compare runs by `step` and
 * `action`: the same line at the same place is the same work.
 */
import type { Action } from "../core/types.js";
import { codeOf } from "../sdk/code.js";
import type { SapTest, Step } from "../record/format.js";

export interface StepTiming {
  /** From 1. */
  step: number;
  /** The SDK line of the action, or "(check)" for a step without one. */
  action: string;
  /** How long the action took, in ms; null when the step kept no time. */
  ms: number | null;
  /** Where the step led: "VA03 SAPMV45A/0102". */
  screen?: string;
}

export interface TraceSummary {
  name: string;
  steps: number;
  /** Sum of the steps' times (steps without one count 0). */
  totalMs: number;
  /** From the first step's start to the last step's end, when the steps kept their start times. */
  wallMs?: number;
  /** Steps that kept a time. */
  timed: number;
  /** The slowest steps, slowest first (at most 3). */
  slowest: StepTiming[];
  timings: StepTiming[];
}

/** The SDK line of a step's action (kept in the trace, else computed). */
export function stepCode(s: Step): string | undefined {
  if (s.code) return s.code;
  if (!s.action) return undefined;
  try {
    return codeOf(s.action as unknown as Action);
  } catch {
    return undefined;
  }
}

/** "VA03 SAPMV45A/0102" for a screen reference; undefined when it says nothing. */
export function screenLabel(r: { transaction?: string | undefined; program?: string | undefined; screen?: string | undefined } | undefined): string | undefined {
  if (!r || (!r.transaction && !r.program && !r.screen)) return undefined;
  const ps = r.program || r.screen ? `${r.program ?? "?"}/${r.screen ?? "?"}` : "";
  return [r.transaction, ps].filter(Boolean).join(" ");
}

/** One perf line per step. */
export function timings(test: SapTest): StepTiming[] {
  return test.steps.map((s, i) => {
    const screen = screenLabel(s.after);
    return { step: i + 1, action: stepCode(s) ?? "(check)", ms: typeof s.ms === "number" ? s.ms : null, ...(screen ? { screen } : {}) };
  });
}

function wall(test: SapTest): number | undefined {
  const first = test.steps.find((s) => s.at);
  const last = [...test.steps].reverse().find((s) => s.at);
  if (!first?.at || !last?.at) return undefined;
  const a = Date.parse(first.at);
  const b = Date.parse(last.at) + (last.ms ?? 0);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
}

export function traceSummary(test: SapTest): TraceSummary {
  const t = timings(test);
  const timed = t.filter((x) => x.ms !== null);
  const w = wall(test);
  return {
    name: test.name,
    steps: t.length,
    totalMs: timed.reduce((n, x) => n + (x.ms ?? 0), 0),
    ...(w !== undefined ? { wallMs: w } : {}),
    timed: timed.length,
    slowest: [...timed].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 3),
    timings: t,
  };
}

/** "420 ms", "1.3 s", "2m 05s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
