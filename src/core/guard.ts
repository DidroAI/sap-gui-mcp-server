/**
 * Guardrails, applied by the server whatever the agent decides:
 * - which systems the server may touch (SAP_ALLOW_SYSTEMS);
 * - which transactions it may open or work in (SAP_ALLOW_TCODES / SAP_BLOCK_TCODES);
 * - the command field, which only {"do":"okcode"} may use;
 * - what happens to actions that may write to the database (SAP_WRITE);
 * - closing the logon or sessions (SAP_ALLOW_LOGOFF).
 */
import type { Action, Assessment, SessionInfo } from "./types.js";

/**
 * confirm (default): each commit runs after the user's yes, asked through the client (MCP elicitation) or a
 * script's onConfirm; refused where nobody can be asked. off: read-only, every commit refused. on: commits run.
 */
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

/** A transaction ("VA03", "/SAPAPO/SDP94") or a Fiori app ("SALESORDER-MANAGE"), as the lists spell them. */
const TCODE_ENTRY = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_.]+$|^[A-Z0-9_]+-[A-Z0-9_]+$/;
/** A system ("ABA") or a system and client ("ABA/800"). */
const SYSTEM_ENTRY = /^[A-Z0-9_]+(\/\d{1,3})?$/;

/**
 * The entries of a list setting, checked: a mistyped entry ("SE*", "/nSE38") would match nothing, and
 * a block list that blocks nothing fails open. A Fiori app may be written "#SalesOrder-manage".
 */
export function checkedList(name: string, entries: string[], kind: "tcode" | "system" = "tcode"): string[] {
  const out = entries.map((e) => (kind === "tcode" ? e.replace(/^#/, "") : e));
  const bad = out.filter((e) => !(kind === "tcode" ? TCODE_ENTRY : SYSTEM_ENTRY).test(e));
  if (bad.length)
    throw new Error(
      `${name}: ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length === 1 ? "is" : "are"} not ${kind === "tcode" ? "a transaction code (VA03, /SAPAPO/SDP94) or a Fiori app (SalesOrder-manage); no wildcards or /n" : "a system (ABA) or system/client (ABA/800)"}`,
    );
  return out;
}

export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  // An empty value counts as unset: clients such as Claude Desktop pass "" for a setting left blank.
  const w = (env.SAP_WRITE?.trim() || "confirm").toLowerCase();
  if (w !== "off" && w !== "confirm" && w !== "on") throw new Error(`SAP_WRITE must be off, confirm or on (got "${env.SAP_WRITE}")`);
  const off = (env.SAP_ALLOW_LOGOFF?.trim() || "off").toLowerCase();
  if (off !== "off" && off !== "on") throw new Error(`SAP_ALLOW_LOGOFF must be off or on (got "${env.SAP_ALLOW_LOGOFF}")`);
  return {
    write: w,
    allowLogoff: off === "on",
    allowSystems: checkedList("SAP_ALLOW_SYSTEMS", list(env.SAP_ALLOW_SYSTEMS), "system"),
    allowTcodes: checkedList("SAP_ALLOW_TCODES", list(env.SAP_ALLOW_TCODES)),
    blockTcodes: checkedList("SAP_BLOCK_TCODES", list(env.SAP_BLOCK_TCODES)),
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

/** The transaction an okcode would open ("/nVA01", "/oVA01", "/*VA01", "VA01"), or the Fiori app an open action names, if any. */
export function tcodeOf(action: Action): string | undefined {
  // Fiori: the app an open action names, as the lists spell an intent ("#SalesOrder-manage?..." -> "SALESORDER-MANAGE").
  if (action.do === "open") return typeof action.app === "string" ? /^#?([A-Za-z0-9_]+-[A-Za-z0-9_]+)/.exec(action.app.trim())?.[1]?.toUpperCase() : undefined;
  if (action.do !== "okcode") return undefined;
  // A Fiori intent sent as an okcode ("#SalesOrder-manage", "/n#SalesOrder-manage?x=1"): a Fiori tab opens
  // that app, so the lists judge it as they judge open.
  const v = typeof action.value === "string" ? action.value.trim() : "";
  const intent = /^(?:\/[nNoO*]\s*)?#([A-Za-z0-9_]+-[A-Za-z0-9_]+)/.exec(v)?.[1];
  if (intent) return intent.toUpperCase();
  const k = okcodeKind(action.value);
  // "/nVA01?x=1": the lists name the transaction, not what follows it.
  return k.kind === "transaction" ? k.tcode.split(/[?&#\s]/)[0] || undefined : undefined;
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
  if (action.do === "open") return !!tcodeOf(action) && !tcodeRefusal(policy, tcodeOf(action));
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

/**
 * After a write that did not run: how to leave the transaction so SAP drops the input and the document's
 * lock. Live 2026-11-20, agents stopped as told and left VA02 or MM02 open with the lock held, offering the
 * user to press Save; the next user (or the next run) was then blocked from that document.
 */
export const LEAVE_UNSAVED =
  'Preserve pre-existing edits. If you are unsure what leaving would discard, stay on the screen and ask the user. If you opened the transaction and only your own disposable input would be lost, leave without saving to release the lock. Use {"do":"okcode","value":"/n"} or Back (F3) and confirm the loss of that input.';

/** LEAVE_UNSAVED for a Fiori app: no command field there; a draft is discarded by its own button. */
export const LEAVE_UNSAVED_FIORI =
  'Preserve pre-existing drafts and edits. If you are unsure what leaving would discard, stay on the page and ask the user. Use "Discard Draft" only for a draft you created whose contents are entirely your own disposable input. For a non-draft page, use Back or {"do":"open","app":"#Shell-home"} only if any input lost is your own and disposable.';

export type Verdict =
  | { run: true }
  | { run: false; refused: string }
  | { run: false; confirm: string };

/**
 * A commit only because the server cannot tell what the action does, not because anything says it writes:
 * the surfaces word it "so what it does is unknown" (a key with no button, a menu entry or an id the
 * server could not read).
 */
export function unknownEffect(assessment: Assessment): boolean {
  return assessment.risk === "commit" && !assessment.closes && /so what it does is unknown/.test(assessment.reason);
}

/** What the server does with an assessed action under the policy. */
export function decide(policy: Policy, action: Action, assessment: Assessment, again = false, fiori = false): Verdict {
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
  // The server could not tell what the action does (a key with no button, an id the view does not show):
  // no write was meant, and one the server can read may well run. Said so, not as a write to give up on.
  if (unknownEffect(assessment))
    return {
      run: false,
      refused: `nothing was sent: ${assessment.reason}, and with writes off only what the server can judge runs. Look at the screen again (sap_look) and use the id of the button, link or row you mean as it shows it, or a key that has a button there; navigation and display functions it can read run with writes off. Only the user can allow writes (SAP_WRITE=confirm or on).`,
    };
  // The second refusal in a session says the rule in one line: the agent has read the whole text once
  // (600 characters on every refusal, live 2026-11-23).
  if (again)
    return {
      run: false,
      refused: `this action may write to SAP (${assessment.reason}) and writes are off. Tell the user. Preserve pre-existing edits${fiori ? " and drafts" : ""}. Discard only your own disposable input (${fiori ? '"Discard Draft" for your own draft, else #Shell-home' : "/n"}). If unsure, stay and ask. Do not retry.`,
    };
  return {
    run: false,
    refused: `this action may write to SAP (${assessment.reason}) and writes are off. Tell the user what you would have saved; do not look for another way. ${fiori ? LEAVE_UNSAVED_FIORI : LEAVE_UNSAVED} Only the user can allow writes (SAP_WRITE=confirm or on).`,
  };
}

/**
 * The destructiveHint of the tools that act: true only when a write or a log off can run without the
 * server asking the user first (SAP_WRITE=on, or SAP_ALLOW_LOGOFF=on). Under confirm the server asks
 * before each write itself (and refuses it when it cannot ask); under off it refuses every write.
 * Clients such as Codex ask before each call of a tool marked destructive: a question per navigation.
 */
export function mayDestroy(policy: Policy): boolean {
  return policy.write === "on" || policy.allowLogoff === true;
}
