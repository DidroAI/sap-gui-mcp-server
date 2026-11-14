/**
 * Is an action a read, a navigation or a commit (a write to the database)?
 *
 * The rule is the three tables below, applied to what the action targets on
 * the current screen:
 * - COMMIT_KEYS: function keys that always save;
 * - COMMIT_WORDS: what a button, a menu entry or a toolbar button says
 *   (text or tooltip), in English, German, French and Spanish;
 * - COMMIT_CODES: function codes, for command-field entries and toolbar
 *   buttons of ALV grids and other controls, whose id is their function code.
 * A popup that asks whether to save, post, delete... makes its "Yes" (and
 * Enter) a commit too.
 *
 * SAP GUI does not say what a button will do, so this is a reading of
 * labels: it errs towards "commit", and a transaction can still write on a
 * step that says nothing of the kind (Execute on a report that updates).
 */
import type { Action, Assessment } from "../core/types.js";
import type { Control, Screen } from "./facts.js";

export const COMMIT_KEYS: Record<number, string> = { 11: "Save (Ctrl+S)" };

export const COMMIT_WORDS: { means: string; words: RegExp }[] = [
  { means: "save", words: /\b(save|sichern|speichern|sauvegarder|enregistrer|guardar|grabar)\b/ },
  { means: "post", words: /\b(post|book|buchen|verbuchen|comptabiliser|contabilizar)\b/ },
  { means: "park or hold", words: /\b(park|hold|vorerfassen|merken)\b/ },
  { means: "delete", words: /\b(delete|löschen|loeschen|supprimer|borrar|eliminar)\b/ },
  { means: "release", words: /\b(release|freigeben|libérer|liberar)\b/ },
  { means: "approve or reject", words: /\b(approve|reject|genehmigen|ablehnen|approuver|rejeter|aprobar|rechazar)\b/ },
  { means: "reverse", words: /\b(reverse|reversal|storno|stornieren|extourner|anular)\b/ },
  // "Cancel" alone leaves a screen; "Cancel document", "Cancel billing" reverse something.
  { means: "cancel a document", words: /\bcancel\s+(?!\()[a-z]/ },
  { means: "activate", words: /\b(activate|aktivieren|activer|activar)\b/ },
  { means: "lock or unlock", words: /\b(lock|unlock|sperren|entsperren)\b/ },
  { means: "send", words: /\b(send|submit|senden|absenden|envoyer|enviar)\b/ },
];

/** "Do not save", "Nicht sichern": the opposite of the word that follows. */
const NEGATION = /\b(do not|don'?t|without|not|nicht|ohne|ne pas|sans)\s*$/;

/** Function codes, compared with each part of a code ("&DATA_SAVE" -> DATA, SAVE). */
export const COMMIT_CODES = new Set([
  ..."SAVE SICH SICHERN BU BUCH BUCHEN POST UPD UPDA UPDATE DEL DELE DELETE DLT LOE LOES LOESCHEN".split(" "),
  ..."FREI FREIGABE REL RELE RELEASE APPR APPROVE STOR STORNO ACT ACTI ACTIVATE PARK HOLD SEND".split(" "),
]);

/** Function codes that only move: typed in the command field, they stay a navigation. */
const SAFE_CODES = new Set("BACK EXIT CANC RW ABBR ENTR ENTE ENTER E ECAN P+ P++ P- P-- PICK".split(" "));

/** Screens where a plain word in the command field is a transaction code, not a function code. */
const MENU_PROGRAMS = new Set(["SAPLSMTR_NAVIGATION", "SAPMSYST", "MENUSYST"]);

const YES = /^(yes|ja|oui|sí|si)$/;
const YES_NAMES = new Set(["SPOP-OPTION1", "BUTTON_1"]);

const clean = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** What a label means, if it means a commit. */
export function commitWord(...labels: (string | undefined)[]): string | undefined {
  for (const label of labels) {
    const l = clean(label);
    for (const row of COMMIT_WORDS) {
      const m = row.words.exec(l);
      if (m && !NEGATION.test(l.slice(0, m.index))) return row.means;
    }
  }
  return undefined;
}

export function commitCode(code: string | undefined): boolean {
  return (code ?? "")
    .toUpperCase()
    .replace(/^[=&%/]+/, "")
    .split(/[_\-.\s]+/)
    .some((part) => COMMIT_CODES.has(part));
}

const shown = (c: Control) => [c.text, c.tip].map((s) => (s ?? "").replace(/\s+/g, " ").trim()).find(Boolean) ?? c.id;

/** The question of the active popup, when it asks whether to save, post, delete... and offers a Yes. */
export function commitQuestion(screen: Screen): string | undefined {
  const w = screen.windows.find((x) => x.id === screen.activeWindow);
  if (!w || w.id === "wnd[0]") return undefined;
  const yes = w.controls.some((c) => c.type === "GuiButton" && (YES_NAMES.has(c.name) || YES.test(clean(c.text))));
  if (!yes) return undefined;
  const texts = w.controls.filter((c) => c.type !== "GuiButton" && c.id !== w.id).map((c) => (c.text ?? "").trim());
  const question = [w.title, ...texts].filter(Boolean).join(" ").replace(/\s+/g, " ");
  return commitWord(question) ? question : undefined;
}

const short = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);

function button(screen: Screen, windowId: string, n: number): Control | undefined {
  const w = screen.windows.find((x) => x.id === windowId);
  return w?.controls.find((c) => c.type === "GuiButton" && new RegExp(`^${windowId.replace(/[[\]]/g, "\\$&")}/tbar\\[[01]\\]/btn\\[${n}\\]$`).test(c.id));
}

function assessButton(screen: Screen, b: Control, how: string): Assessment {
  if (/(^|\/)tbar\[0\]\/btn\[11\]$/.test(b.id)) return { risk: "commit", reason: `${how}"${shown(b)}" (Save)` };
  const means = commitWord(b.text, b.tip);
  if (means) return { risk: "commit", reason: `${how}"${shown(b)}"` };
  const question = commitQuestion(screen);
  if (question && b.id.startsWith(`${screen.activeWindow}/`) && (YES_NAMES.has(b.name) || YES.test(clean(b.text))))
    return { risk: "commit", reason: `"${shown(b)}" on the popup "${short(question)}"` };
  return { risk: "navigate", reason: `${how}"${shown(b)}"` };
}

function assessKey(screen: Screen, windowId: string, n: number, how: string): Assessment {
  const always = COMMIT_KEYS[n];
  if (always) return { risk: "commit", reason: `${how}: ${always}` };
  const b = button(screen, windowId, n);
  if (b) {
    const a = assessButton(screen, b, `${how}: button `);
    if (a.risk === "commit") return a;
  }
  const question = n === 0 && windowId === screen.activeWindow ? commitQuestion(screen) : undefined;
  if (question) return { risk: "commit", reason: `Enter on the popup "${short(question)}"` };
  if (n === 4 || n === 1) return { risk: "read", reason: n === 4 ? "value help" : "help" };
  return { risk: "navigate", reason: how };
}

function assessOkcode(screen: Screen, value: unknown): Assessment {
  const v = String(value ?? "").trim();
  const u = v.toUpperCase();
  const how = `okcode ${v}`;
  const key = /^\/(\d+)$/.exec(u);
  if (key) return assessKey(screen, "wnd[0]", Number(key[1]), how);
  // /nXXXX, /oXXXX, /*XXXX start a transaction; /i, /nend, /nex close sessions. Unsaved input is dropped, nothing is written.
  if (u === "" || /^\/[NO*I]/.test(u)) return { risk: "navigate", reason: how };
  if (commitCode(u)) return { risk: "commit", reason: `${how} (a function code that saves, posts or deletes)` };
  const code = u.replace(/^=/, "");
  if (SAFE_CODES.has(code) || /^[%&?]/.test(code) || MENU_PROGRAMS.has(screen.program.toUpperCase())) return { risk: "navigate", reason: how };
  return { risk: "commit", reason: `${how} (a function code of this screen that the server cannot classify)` };
}

/**
 * @param target the control the action's id means (resolve.ts), when it has one and it was found.
 */
export function assess(screen: Screen, action: Action, target?: Control): Assessment {
  const active = screen.activeWindow ?? "wnd[0]";
  switch (action.do) {
    case "focus":
      return { risk: "read", reason: "focus" };
    case "f4":
      return { risk: "read", reason: "value help" };
    case "set":
    case "check":
    case "combo":
      return { risk: "navigate", reason: "changes input, not saved" };
    case "okcode":
      return assessOkcode(screen, action.value);
    case "key": {
      const n = Number(action.key);
      return assessKey(screen, active, n, `key ${n}`);
    }
    case "press":
      if (target?.type === "GuiButton") return assessButton(screen, target, "button ");
      return { risk: "navigate", reason: "press" };
    case "select": {
      if (target?.type === "GuiMenu" || /\/mbar\//.test(target?.id ?? action.id ?? "")) {
        if (!target) return { risk: "commit", reason: "a menu entry the server could not read" };
        return commitWord(target.text, target.tip)
          ? { risk: "commit", reason: `menu entry "${shown(target)}"` }
          : { risk: "navigate", reason: `menu entry "${shown(target)}"` };
      }
      return { risk: "navigate", reason: "select" };
    }
    case "toolbar": {
      const id = String(action.button ?? "");
      const b = target?.buttons?.find((x) => x.id === id);
      const label = b ? [b.text, b.tip].map((s) => s.trim()).find(Boolean) ?? id : id;
      if (commitWord(b?.text, b?.tip) || commitCode(id)) return { risk: "commit", reason: `toolbar button "${label}" {${id}}` };
      return { risk: "navigate", reason: `toolbar button "${label}"` };
    }
    case "tree":
      return action.how === "expand" || action.how === "collapse" ? { risk: "read", reason: `${action.how} a tree node` } : { risk: "navigate", reason: "tree node" };
    default:
      return { risk: "navigate", reason: action.do };
  }
}
