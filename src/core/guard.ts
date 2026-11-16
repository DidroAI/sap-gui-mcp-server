/**
 * Guardrails, applied by the server whatever the agent decides:
 * - which systems the server may touch (SAP_ALLOW_SYSTEMS);
 * - which transactions it may open or work in (SAP_ALLOW_TCODES / SAP_BLOCK_TCODES);
 * - the command field, which only {"do":"okcode"} may use;
 * - what happens to actions that may write to the database (SAP_WRITE);
 * - closing the logon or sessions (SAP_ALLOW_LOGOFF).
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
  /**
   * May the agent end SAP sessions or the logon (/nex, /nend, /i, Log Off)?
   * Off by default, also with SAP_WRITE=on: it drops the unsaved work of every
   * session of the user, and nothing more can be done until the user logs on again.
   */
  allowLogoff?: boolean;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const w = (env.SAP_WRITE ?? "off").toLowerCase();
  if (w !== "off" && w !== "confirm" && w !== "on") throw new Error(`SAP_WRITE must be off, confirm or on (got "${env.SAP_WRITE}")`);
  const off = (env.SAP_ALLOW_LOGOFF ?? "off").toLowerCase();
  if (off !== "off" && off !== "on") throw new Error(`SAP_ALLOW_LOGOFF must be off or on (got "${env.SAP_ALLOW_LOGOFF}")`);
  return {
    write: w,
    allowLogoff: off === "on",
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

/**
 * What a command typed into the command field does, as far as the guard cares:
 * - transaction: it opens one ("/nVA01", "/oVA01", "/*VA01", "/n/SAPAPO/SDP94", or "VA01" alone);
 * - close: it ends sessions or the logon ("/nex", "/nend", "/i", "/i3"). These are not
 *   transactions: the allow and block lists do not apply, the surface's rules decide;
 * - other: a function key ("/11"), "/n" alone, "/o" alone (the session list), "/h", "=SAVE"...
 */
export type Okcode = { kind: "transaction"; tcode: string } | { kind: "close" } | { kind: "other" };

export function okcodeKind(value: unknown): Okcode {
  if (typeof value !== "string") return { kind: "other" };
  const v = value.trim();
  if (/^\/i\d*$/i.test(v)) return { kind: "close" };
  const m = /^\/([nNoO*])\s*(\S*)/.exec(v);
  if (m) {
    const t = (m[2] ?? "").toUpperCase();
    if (!t) return { kind: "other" };
    if ((m[1] === "n" || m[1] === "N") && (t === "EX" || t === "END")) return { kind: "close" };
    return { kind: "transaction", tcode: t };
  }
  // "/11", "/h", "/$sync": commands, not transactions.
  if (v.startsWith("/")) return { kind: "other" };
  const t = /^([A-Za-z0-9_.]+(?:\/[A-Za-z0-9_.]+)*)$/.exec(v)?.[1]?.toUpperCase();
  if (!t || /^\d+$/.test(t)) return { kind: "other" };
  return { kind: "transaction", tcode: t };
}

/** The transaction an okcode would open ("/nVA01", "/oVA01", "/*VA01", "VA01"), if any. */
export function tcodeOf(action: Action): string | undefined {
  if (action.do !== "okcode") return undefined;
  const k = okcodeKind(action.value);
  return k.kind === "transaction" ? k.tcode : undefined;
}

/**
 * Is this id the command field? "okcd", "wnd[0]/tbar[0]/okcd", with or without a
 * session prefix, and Web GUI's own element, "ToolbarOkCode" or "#ToolbarOkCode".
 */
export function isCommandField(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const s = id.trim().toLowerCase();
  return /(^|[/#])okcd$/.test(s) || /(^|[/#])(toolbar)?okcode$/.test(s);
}

/**
 * Why an action on the command field is refused, or undefined. Typing a command
 * there with "set" and sending it with Enter would pass every okcode rule
 * (transaction lists, function codes that save): the only way in is
 * {"do":"okcode"}, which the guard reads.
 */
export function commandFieldRefusal(action: Action): string | undefined {
  if (action.do === "okcode" || !isCommandField(action.id)) return undefined;
  return `"${action.do}" on the command field is not allowed. To run a command, use {"do":"okcode","value":"/nVA03"}.`;
}

/** Screens every session starts from: with SAP_ALLOW_TCODES set, a session may still sit on them. */
const HOME = new Set(["SESSION_MANAGER", "SMEN", "S000", "SHELL-HOME"]);

/** The transaction a session shows, as the lists spell it ("VA01 (start)" -> "VA01"). */
export function currentTcode(s: Pick<SessionInfo, "transaction">): string | undefined {
  const t = (s.transaction ?? "").trim().split(/\s+/)[0]?.toUpperCase();
  return t || undefined;
}

/** Why the transaction a session is in is refused, or undefined. Menus, favourites and tree nodes open transactions without an okcode. */
export function sessionRefusal(policy: Policy, s: Pick<SessionInfo, "transaction">): string | undefined {
  const t = currentTcode(s);
  if (!t) return undefined;
  if (policy.blockTcodes.includes(t)) return `transaction ${t} is blocked (SAP_BLOCK_TCODES)`;
  if (policy.allowTcodes.length && !policy.allowTcodes.includes(t) && !HOME.has(t)) return `transaction ${t} is not in SAP_ALLOW_TCODES`;
  return undefined;
}

/** Does this action leave the current transaction ("/n", a session close, or opening a transaction the lists allow)? */
export function leavesTransaction(policy: Policy, action: Action): boolean {
  if (action.do !== "okcode" || typeof action.value !== "string") return false;
  if (/^\/n$/i.test(action.value.trim())) return true;
  const k = okcodeKind(action.value);
  if (k.kind === "close") return true;
  return k.kind === "transaction" && /^\/[nN*]/.test(action.value.trim()) && !tcodeRefusal(policy, k.tcode);
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
  const field = commandFieldRefusal(action);
  if (field) return { run: false, refused: field };
  const refusal = tcodeRefusal(policy, tcodeOf(action));
  if (refusal) return { run: false, refused: refusal };
  // Ending the logon is its own risk: not a write, yet it cannot be undone by the agent (every session and
  // its unsaved input is gone, and only the user can log on again). Refused unless the user allowed it.
  if (assessment.closes) {
    if (policy.allowLogoff) return { run: true };
    return {
      run: false,
      refused: `this action ends SAP sessions or the logon (${assessment.reason}): every session of the user and its unsaved data would be gone, and only the user can log on again. To leave a transaction, use {"do":"okcode","value":"/n"}. The user can allow logging off with SAP_ALLOW_LOGOFF=on.`,
    };
  }
  if (assessment.risk !== "commit") return { run: true };
  if (policy.write === "on") return { run: true };
  if (policy.write === "confirm") return { run: false, confirm: assessment.reason };
  return {
    run: false,
    refused: `this action may write to SAP (${assessment.reason}) and writes are off. The user can allow them with SAP_WRITE=confirm or SAP_WRITE=on.`,
  };
}
