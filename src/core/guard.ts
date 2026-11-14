/**
 * Guardrails, applied by the server whatever the agent decides:
 * - which systems the server may touch (SAP_ALLOW_SYSTEMS);
 * - which transactions it may open (SAP_ALLOW_TCODES / SAP_BLOCK_TCODES);
 * - what happens to actions that may write to the database (SAP_WRITE).
 */
import type { Action, Assessment, SessionInfo } from "./types.js";

/** off: commits are refused (default). confirm: each commit waits for sap_confirm. on: commits run. */
export type WriteMode = "off" | "confirm" | "on";

export interface Policy {
  write: WriteMode;
  /** "ABA", "ABA/800"; empty = every system. */
  allowSystems: string[];
  allowTcodes: string[];
  blockTcodes: string[];
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const w = (env.SAP_WRITE ?? "off").toLowerCase();
  if (w !== "off" && w !== "confirm" && w !== "on") throw new Error(`SAP_WRITE must be off, confirm or on (got "${env.SAP_WRITE}")`);
  return {
    write: w,
    allowSystems: list(env.SAP_ALLOW_SYSTEMS),
    allowTcodes: list(env.SAP_ALLOW_TCODES),
    blockTcodes: list(env.SAP_BLOCK_TCODES),
  };
}

/** Is this session one the server may touch? Unknown system ids pass only when no list is set. */
export function systemAllowed(policy: Policy, s: SessionInfo): boolean {
  if (policy.allowSystems.length === 0) return true;
  const sys = (s.system ?? "").toUpperCase();
  const cl = (s.client ?? "").toUpperCase();
  return policy.allowSystems.some((a) => {
    const [aSys, aCl] = a.split("/");
    return aSys === sys && (!aCl || aCl === cl);
  });
}

/** The transaction an okcode would open ("/nVA01", "/oVA01", "VA01"), if any. */
export function tcodeOf(action: Action): string | undefined {
  if (action.do !== "okcode" || typeof action.value !== "string") return undefined;
  const m = /^\s*(?:\/[nNoO])?\s*([A-Za-z0-9_/]+)\s*$/.exec(action.value);
  const t = m?.[1]?.toUpperCase();
  // "/11", "/00", "/nEND" style function codes are not transactions.
  if (!t || /^\d+$/.test(t) || t.startsWith("/")) return undefined;
  return t;
}

/** Why a transaction is refused, or undefined when allowed. */
export function tcodeRefusal(policy: Policy, tcode: string | undefined): string | undefined {
  if (!tcode) return undefined;
  const t = tcode.toUpperCase();
  if (policy.blockTcodes.includes(t)) return `transaction ${t} is blocked (SAP_BLOCK_TCODES)`;
  if (policy.allowTcodes.length && !policy.allowTcodes.includes(t)) return `transaction ${t} is not in SAP_ALLOW_TCODES`;
  return undefined;
}

export type Verdict =
  | { run: true }
  | { run: false; refused: string }
  | { run: false; confirm: string };

/** What the server does with an assessed action under the policy. */
export function decide(policy: Policy, action: Action, assessment: Assessment): Verdict {
  const refusal = tcodeRefusal(policy, tcodeOf(action));
  if (refusal) return { run: false, refused: refusal };
  if (assessment.risk !== "commit") return { run: true };
  if (policy.write === "on") return { run: true };
  if (policy.write === "confirm") return { run: false, confirm: assessment.reason };
  return {
    run: false,
    refused: `this action may write to SAP (${assessment.reason}) and writes are off. The user can allow them with SAP_WRITE=confirm or SAP_WRITE=on.`,
  };
}
