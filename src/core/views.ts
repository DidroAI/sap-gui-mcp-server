/**
 * The views each session's agent was given last, and what to answer after an
 * action: the whole view, or only what changed.
 *
 * The whole view goes out on a new transaction, screen or window, and when
 * the changes are not much shorter than the view. A popup that opened and
 * closed leads back to the screen below it, which the agent saw before the
 * popup: the changes are then counted from that view, and the header says so.
 */
import { diffViews, isFioriView, popupOver, sameScreen } from "./diff.js";

export type ViewMode = "diff" | "full";

/** `SAP_VIEW=full` answers every action with the whole screen; the default answers with the changes when that is shorter. */
export function viewModeFromEnv(env: Record<string, string | undefined>): ViewMode {
  const v = (env.SAP_VIEW ?? "").trim().toLowerCase();
  if (v && v !== "diff" && v !== "full") throw new Error(`SAP_VIEW must be diff or full, not "${env.SAP_VIEW}"`);
  return v === "full" ? "full" : "diff";
}

/** Lines of a Fiori view that are no control of the page: kept when the page behind a popup is left out. */
const FIORI_KEEP = /^(FIORI|PAGE|DRAFT|TOAST|SCROLL|NOTE|PANEL|NUMBERS)\b/;

/**
 * A Fiori view with a popup open, for an action's answer: the popup whole, the page behind it as one line
 * (live 2026-11-23: a value help answer of 9.7 KB, a link's popover 4.4 KB, mostly the page behind them).
 * The view itself is unchanged when there is no popup or little behind it.
 */
export function fioriPopupFirst(view: string): string {
  if (!isFioriView(view)) return view;
  const lines = view.split("\n");
  if (!lines.some((l) => l.startsWith("POPUP "))) return view;
  const out: string[] = [];
  let behind = 0;
  let inPopup = false;
  let at = -1;
  for (const l of lines) {
    if (l.startsWith("POPUP ")) inPopup = true;
    else if (!l.startsWith(" ")) inPopup = false;
    if (inPopup || FIORI_KEEP.test(l)) {
      out.push(l);
      continue;
    }
    if (at < 0) at = out.length;
    behind++;
  }
  if (behind < 8 || at < 0) return view;
  out.splice(at, 0, `(the page behind the popup: ${behind} lines, not repeated here; close the popup to work on it, sap_look shows it)`);
  return out.join("\n");
}

/** A diff longer than this share of the view is not worth it: the whole view is clearer. */
const WORTH_IT = 0.6;
/** How many earlier views of a session are kept to diff against. */
const KEPT = 3;

export class Views {
  private bySession = new Map<string, string[]>();

  constructor(readonly mode: ViewMode = "diff") {}

  /** The agent was given this (compact) view of the session. */
  remember(session: string, view: string): void {
    const kept = (this.bySession.get(session) ?? []).filter((v) => !sameScreen(v, view));
    kept.push(view);
    this.bySession.set(session, kept.slice(-KEPT));
  }

  /** The view the agent got last, if any. */
  last(session: string): string | undefined {
    return this.bySession.get(session)?.at(-1);
  }

  forget(session: string): void {
    this.bySession.delete(session);
  }

  /**
   * What to answer with for `view`: the changes since the agent's last view
   * of this screen when that is clearly shorter, else the view. Either way
   * the view is remembered as given.
   */
  present(session: string, view: string, whole = false): string {
    const kept = this.bySession.get(session) ?? [];
    let answer = view;
    if (!whole && this.mode === "diff") {
      for (let i = kept.length - 1; i >= 0; i--) {
        const prev = kept[i] as string;
        if (!sameScreen(prev, view)) {
          // Popups that opened over this screen and closed again: the screen below never left.
          if (popupOver(prev, view)) continue;
          break;
        }
        // The popups that closed since: the top window of each view given after this screen.
        const closed = [...new Set(kept.slice(i + 1).map((v) => v.split("\n").filter((l) => l.startsWith("WINDOW ") || l.startsWith("POPUP ")).at(-1) ?? "").filter(Boolean))];
        const d = diffViews(prev, view, "", closed);
        if (d.text.length <= view.length * WORTH_IT) answer = d.text;
        break;
      }
      if (answer === view) answer = fioriPopupFirst(view);
    }
    this.remember(session, view);
    return answer;
  }
}
