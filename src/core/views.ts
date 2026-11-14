/**
 * The views each session's agent was given last, and what to answer after an
 * action: the whole view, or only what changed.
 *
 * The whole view goes out on a new transaction, screen or window, and when
 * the changes are not much shorter than the view. A popup that opened and
 * closed leads back to the screen below it, which the agent saw before the
 * popup: the changes are then counted from that view, and the header says so.
 */
import { diffViews, popupOver, sameScreen } from "./diff.js";

export type ViewMode = "diff" | "full";

/** `SAP_VIEW=full` answers every action with the whole screen; the default answers with the changes when that is shorter. */
export function viewModeFromEnv(env: Record<string, string | undefined>): ViewMode {
  const v = (env.SAP_VIEW ?? "").trim().toLowerCase();
  if (v && v !== "diff" && v !== "full") throw new Error(`SAP_VIEW must be diff or full, not "${env.SAP_VIEW}"`);
  return v === "full" ? "full" : "diff";
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
        const d = diffViews(prev, view, i < kept.length - 1 ? " since you last saw this screen, before the popup" : "");
        if (d.text.length <= view.length * WORTH_IT) answer = d.text;
        break;
      }
    }
    this.remember(session, view);
    return answer;
  }
}
