/**
 * What a Fiori action may do to the system: read, navigate or commit.
 *
 * The rule is a table (RULES): the first row that matches the control decides.
 * It reads four things of the control, all found by the in-page reader
 * (ControlFacts in ui5.ts): its id (Fiori elements gives its standard actions
 * stable ids), its press handler names, its text, and its button type with
 * where it sits (page footer, dialog, filter bar, value help).
 *
 * Draft apps: typing into a field of a draft-enabled app saves the draft on
 * the server at once. That is not counted as a commit; activating the draft
 * (Save, Create) is.
 */
import type { Action, Assessment, Risk } from "../core/types.js";
import type { ControlFacts } from "./ui5.js";

const word = (list: string) => new RegExp(`(?<![\\p{L}\\p{N}])(${list})(?![\\p{L}\\p{N}])`, "iu");

/** Verbs that write: English, German, French. Matched as whole words anywhere in a button's text. */
export const COMMIT_TEXT = word(
  [
    "save|create|post|delete|submit|approve|reject|release|activate|deactivate|confirm|send|book|execute|withdraw|accept|decline|complete|copy|upload|import|publish|reverse",
    "speichern|sichern|anlegen|erstellen|buchen|löschen|senden|absenden|genehmigen|ablehnen|freigeben|aktivieren|bestätigen|ausführen|kopieren|stornieren",
    "enregistrer|sauvegarder|créer|comptabiliser|supprimer|soumettre|envoyer|approuver|rejeter|refuser|libérer|activer|confirmer|valider|exécuter|copier|annuler la",
  ].join("|"),
);

/** Texts that say a button does not write, even when it is emphasized. Matched at the start of the text. */
export const SAFE_TEXT = new RegExp(
  `^(?:${[
    "(?:ok|yes|no|go|cancel|close|back|next|previous|continue|more|less|help)$",
    "(?:edit|display|show|hide|view|open|search|filter|sort|group|expand|collapse|refresh|export|print|select|choose|clear|reset|restore|adapt|discard|keep|details|settings|sign out|log off|share|navigate|leave)(?![\\p{L}\\p{N}])",
    "(?:ja|nein|abbrechen|schließen|zurück|weiter|start|los)$",
    "(?:bearbeiten|anzeigen|suchen|filtern|sortieren|verwerfen|auswählen|aktualisieren|drucken|exportieren|abmelden)(?![\\p{L}\\p{N}])",
    "(?:oui|non|annuler|fermer|retour|suivant|précédent|continuer|lancer|démarrer)$",
    "(?:modifier|afficher|rechercher|filtrer|trier|rejeter les modifications|sélectionner|actualiser|imprimer|exporter|se déconnecter)(?![\\p{L}\\p{N}])",
  ].join("|")})`,
  "iu",
);

/** Texts that only agree with what the dialog asks: the dialog's own text then says what happens. */
const CONFIRM_TEXT = /^(ok|yes|continue|ja|weiter|oui|continuer)$/i;

/** Standard actions of SAP Fiori elements by id: OData V4 (`fe::…StandardAction::Save`) and V2 (`--save`, `--activate`). */
const ID_COMMIT = /::StandardAction::(Save|Create|Delete|CreateDocument|MassEdit|Paste|Insert)\b|(?:--|::)(save|activate|delete|deleteEntry|addEntry|copy|copyButton|saveAsDraft|saveAndNew|saveAndNext|activateAndNew)$/i;
const ID_SAFE = /::StandardAction::(Edit|Cancel|Discard|SwitchToActiveObject|SwitchToDraftObject|SwitchDraftAndActiveObject|FullScreen|EnterFullScreen|ExitFullScreen|Close|Share)\b|(?:--|::)(edit|discard|cancel|close|back|fullScreen|closeColumn|exitFullScreen|share)$/i;
/** A back-end action behind a button: an OData action or function import (`DataFieldForAction`, `--action::…`). */
const ID_ACTION = /DataFieldForAction::|(?:--|::)action::/i;
const ID_READ = /-btnGo$|-btnSearch$|::FilterBar-btnSearch$|-btn(Filters|Clear|Restore|ShowHide|AdaptFilters)$|::AdaptFilters$|-vhi$|-valueHelp|::StandardAction::(Sort|Filter|Group|Personalization|Export|ExportToExcel|ShowDetails|HideDetails)\b|-(btnPersonalisation|btnExcelExport|btnFullScreen|header-expandBtn|expandBtn|collapseBtn|pinBtn)$|-searchField/i;
const HANDLER_COMMIT = /save|create|post|delet|submit|approv|reject|release|activat|commit|send/i;

const BUTTON_LIKE = /Button$|MenuItem$|ActionListItem$|ActionSelect$|sap\.m\.Link$/;
const ROW_LIKE = /ColumnListItem$|sap\.ui\.table\.Row$|ListItem$|Tile$|TileContent$|IconTabFilter$|SegmentedButtonItem$|ObjectPageSection$|ObjectPageSubSection$|VizInstance/;
const FIELD_LIKE = /Input$|Field$|TextArea$|Picker$|ComboBox$|Select$|CheckBox$|Switch$|RadioButton$|DynamicDateRange$|Token$|Tokenizer$|Slider$/;
const STRONG_TYPE = /^(Emphasized|Accept|Reject)$/;

const isButton = (f: ControlFacts) => BUTTON_LIKE.test(f.type) || (/ListItem$/.test(f.type) && /Popover$|ActionSheet$|Menu$/.test(f.dialog?.type ?? ""));
const commitText = (s: string | undefined) => (s ? COMMIT_TEXT.exec(s)?.[1] : undefined);

export interface Rule {
  /** Short name, shown in tests and used in the reason. */
  name: string;
  risk: Risk;
  when: (f: ControlFacts) => boolean;
}

/**
 * The table. Order matters: ids first (the most certain), then links and
 * rows, then the text, then the button type with its place.
 */
export const RULES: Rule[] = [
  { name: "standard action that writes (id)", risk: "commit", when: (f) => ID_COMMIT.test(f.id) },
  { name: "back-end action (id)", risk: "commit", when: (f) => ID_ACTION.test(f.id) },
  { name: "value help, filter or search (id)", risk: "read", when: (f) => ID_READ.test(f.id) },
  { name: "standard action that does not write (id)", risk: "navigate", when: (f) => ID_SAFE.test(f.id) },
  { name: "link with an address", risk: "navigate", when: (f) => !!f.href },
  { name: "row, tile, tab or list entry", risk: "navigate", when: (f) => ROW_LIKE.test(f.type) && !isButton(f) },
  { name: "field", risk: "navigate", when: (f) => FIELD_LIKE.test(f.type) && !isButton(f) },
  { name: "press handler that writes", risk: "commit", when: (f) => isButton(f) && (f.handlers ?? []).some((h) => HANDLER_COMMIT.test(h)) },
  { name: "text says it does not write", risk: "navigate", when: (f) => isButton(f) && SAFE_TEXT.test(f.text) && !(CONFIRM_TEXT.test(f.text) && f.dialog) },
  { name: "text says it writes", risk: "commit", when: (f) => isButton(f) && !!commitText(f.text) },
  {
    name: "agrees to a dialog that writes",
    risk: "commit",
    when: (f) => isButton(f) && CONFIRM_TEXT.test(f.text) && !!f.dialog && !f.inValueHelp && !!commitText(`${f.dialog.title} ${f.dialog.text}`),
  },
  { name: "agrees to a dialog", risk: "navigate", when: (f) => isButton(f) && CONFIRM_TEXT.test(f.text) && !!f.dialog },
  { name: "button of a filter bar or value help", risk: "read", when: (f) => isButton(f) && (!!f.inFilterBar || !!f.inValueHelp) },
  { name: "emphasized button of a footer toolbar", risk: "commit", when: (f) => isButton(f) && !!f.inFooter && STRONG_TYPE.test(f.buttonType ?? "") },
  { name: "emphasized button of a dialog", risk: "commit", when: (f) => isButton(f) && !!f.dialog && /Dialog$|MessageBox$/.test(f.dialog.type) && STRONG_TYPE.test(f.buttonType ?? "") },
];

const label = (f: ControlFacts) => `${f.type.replace(/^.*\./, "").toLowerCase()} "${f.text || f.icon || f.id.split(/--|::/).pop()}"`;

/** Pressing, clicking or selecting one control. */
export function assessControl(f: ControlFacts): Assessment & { rule: string } {
  for (const r of RULES) if (r.when(f)) return { risk: r.risk, reason: `${label(f)}: ${r.name}`, rule: r.name };
  return { risk: "navigate", reason: label(f), rule: "default" };
}

/** Keys the Fiori driver knows, by the name Playwright presses. */
export const KEYS: Record<string, { press: string; risk: Risk }> = {
  enter: { press: "Enter", risk: "navigate" },
  escape: { press: "Escape", risk: "navigate" },
  esc: { press: "Escape", risk: "navigate" },
  tab: { press: "Tab", risk: "read" },
  "shift+tab": { press: "Shift+Tab", risk: "read" },
  f4: { press: "F4", risk: "read" },
  arrowdown: { press: "ArrowDown", risk: "read" },
  arrowup: { press: "ArrowUp", risk: "read" },
  arrowleft: { press: "ArrowLeft", risk: "read" },
  arrowright: { press: "ArrowRight", risk: "read" },
  pagedown: { press: "PageDown", risk: "read" },
  pageup: { press: "PageUp", risk: "read" },
  home: { press: "Home", risk: "read" },
  end: { press: "End", risk: "read" },
  back: { press: "Back", risk: "navigate" },
  "control+s": { press: "Control+s", risk: "commit" },
  "control+enter": { press: "Control+Enter", risk: "commit" },
};
/** SAP GUI virtual keys an agent may send out of habit: 0 Enter, 3 Back, 4 F4, 11 Save, 12 Cancel. */
const VKEYS: Record<number, string> = { 0: "enter", 3: "back", 4: "f4", 11: "control+s", 12: "escape" };

/** The key of a key action, normalised to an entry of KEYS (or undefined). */
export function keyOf(action: Action): { name: string; press: string; risk: Risk } | undefined {
  const k = action.key ?? action.value;
  const raw = typeof k === "number" || /^\d+$/.test(String(k ?? "")) ? VKEYS[Number(k)] : String(k ?? "");
  const name = (raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^ctrl\+/, "control+")
    .replace(/^return$/, "enter");
  const e = KEYS[name];
  return e ? { name, ...e } : undefined;
}

/** What the page says about the place a key would land: the focused control and the open dialog's default button. */
export interface KeyContext {
  focused?: ControlFacts | undefined;
  dialogDefault?: ControlFacts | undefined;
}

/**
 * One action, from the facts of its control (undefined when the id is not on
 * the screen: the action will fail, nothing is written).
 */
export function assessAction(action: Action, facts: ControlFacts | undefined, ctx: KeyContext = {}): Assessment {
  const d = action.do;
  if (d === "scroll" || d === "f4") return { risk: "read", reason: d === "f4" ? "value help" : "scroll" };
  if (d === "key") {
    const k = keyOf(action);
    if (!k) return { risk: "commit", reason: `key ${JSON.stringify(action.key ?? action.value ?? "")} is not one the Fiori surface knows` };
    if (k.risk === "commit") return { risk: "commit", reason: `key ${k.press} saves in Fiori apps` };
    if (k.name === "enter") {
      // Enter presses the focused button, or the default button of an open dialog.
      for (const f of [ctx.focused, ctx.dialogDefault]) {
        if (!f || !isButton(f)) continue;
        const a = assessControl(f);
        if (a.risk === "commit") return { risk: "commit", reason: `Enter would press ${a.reason}` };
      }
    }
    return { risk: k.risk, reason: `key ${k.press}` };
  }
  if (!facts) return { risk: "read", reason: `no control "${action.id ?? ""}" on the screen` };
  if (d === "set" || d === "fill" || d === "combo" || d === "check") {
    const where = facts.inValueHelp ? "value help" : facts.inFilterBar ? "filter" : "";
    return where ? { risk: "read", reason: `${where} field` } : { risk: "navigate", reason: `unsaved input in ${label(facts)}` };
  }
  if (d === "press" || d === "click" || d === "select" || d === "dblclick" || d === "double") return assessControl(facts);
  return { risk: "commit", reason: `action "${d}" is not one the Fiori surface knows` };
}
