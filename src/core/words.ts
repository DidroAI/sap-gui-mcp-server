/**
 * What the texts and codes of SAP screens mean for the guard, in one table
 * for the three surfaces (SAP GUI for Windows, Web GUI, Fiori).
 *
 * The rule the surfaces build on it: a button, a menu entry, a function key
 * or a function code is a commit (it may write to SAP) unless it is known to
 * be safe. So there are two lists:
 *
 * - COMMIT_WORDS: verbs that write. A text that holds one is a commit, even
 *   when it also holds a safe word ("Save and back"). English, German,
 *   French, Spanish, Portuguese, Italian and Dutch.
 * - SAFE_WORDS: what moves around or only shows something. English, German,
 *   French and Spanish. A text is safe when it holds one of these and no
 *   commit word.
 *
 * Safe words are trusted only when the session's logon language is one of
 * SAFE_LANGUAGES. In any other language a text proves nothing, and a button
 * or menu entry is safe only by its id, its function key or its function code.
 *
 * To cover a new case, add a word or a code here; the surfaces do not change.
 */

export type CommitLanguage = "en" | "de" | "fr" | "es" | "pt" | "it" | "nl";
export type SafeLanguage = "en" | "de" | "fr" | "es";

export const SAFE_LANGUAGES: readonly SafeLanguage[] = ["en", "de", "fr", "es"];

/** One meaning, and the words for it in each language. A word can be a phrase ("change status"). */
export interface WordRow<L extends string> {
  means: string;
  words: Partial<Record<L, string[]>>;
}

export const COMMIT_WORDS: WordRow<CommitLanguage>[] = [
  {
    means: "save",
    words: {
      en: ["save"],
      de: ["sichern", "speichern"],
      fr: ["sauvegarder", "enregistrer"],
      es: ["guardar", "grabar"],
      pt: ["gravar", "salvar", "guardar"],
      it: ["salvare", "salva"],
      nl: ["opslaan", "bewaren", "veiligstellen"],
    },
  },
  {
    means: "post",
    words: {
      en: ["post", "book"],
      de: ["buchen", "verbuchen"],
      fr: ["comptabiliser"],
      es: ["contabilizar"],
      pt: ["lançar", "contabilizar"],
      it: ["registrare", "contabilizzare"],
      nl: ["boeken"],
    },
  },
  {
    means: "park or hold",
    words: { en: ["park", "hold"], de: ["vorerfassen", "merken"], fr: ["préenregistrer"], es: ["registrar preliminarmente"], pt: ["pré-editar"], it: ["preregistrare"], nl: ["voorlopig boeken"] },
  },
  {
    means: "delete",
    words: {
      en: ["delete", "remove", "deletion"],
      de: ["löschen", "loeschen", "entfernen", "löschvormerkung", "löschkennzeichen"],
      fr: ["supprimer", "effacer", "suppression"],
      es: ["borrar", "eliminar", "suprimir"],
      pt: ["eliminar", "excluir", "apagar"],
      it: ["eliminare", "cancellare", "elimina"],
      nl: ["verwijderen", "wissen"],
    },
  },
  {
    means: "release",
    words: { en: ["release"], de: ["freigeben", "freigabe"], fr: ["libérer"], es: ["liberar"], pt: ["liberar", "libertar"], it: ["rilasciare"], nl: ["vrijgeven"] },
  },
  {
    means: "approve or reject",
    words: {
      en: ["approve", "reject", "accept", "decline"],
      de: ["genehmigen", "ablehnen", "annehmen"],
      fr: ["approuver", "rejeter", "refuser", "accepter"],
      es: ["aprobar", "rechazar", "aceptar"],
      pt: ["aprovar", "rejeitar", "recusar", "aceitar"],
      it: ["approvare", "rifiutare", "respingere", "accettare"],
      nl: ["goedkeuren", "afwijzen", "accepteren"],
    },
  },
  {
    means: "reverse",
    words: {
      en: ["reverse", "reversal"],
      de: ["storno", "stornieren"],
      fr: ["extourner", "contre-passer", "annulation"],
      es: ["anular", "anulación"],
      pt: ["estornar", "estorno"],
      it: ["stornare", "storno"],
      nl: ["storneren", "terugboeken"],
    },
  },
  {
    means: "activate",
    words: {
      en: ["activate", "deactivate"],
      de: ["aktivieren", "deaktivieren"],
      fr: ["activer", "désactiver"],
      es: ["activar", "desactivar"],
      pt: ["ativar", "desativar"],
      it: ["attivare", "disattivare"],
      nl: ["activeren", "deactiveren"],
    },
  },
  {
    means: "lock or unlock",
    words: {
      en: ["lock", "unlock", "block", "unblock"],
      de: ["sperren", "entsperren"],
      fr: ["bloquer", "débloquer", "verrouiller", "déverrouiller"],
      es: ["bloquear", "desbloquear"],
      pt: ["bloquear", "desbloquear"],
      it: ["bloccare", "sbloccare"],
      nl: ["blokkeren", "deblokkeren"],
    },
  },
  {
    means: "send",
    words: {
      en: ["send", "submit"],
      de: ["senden", "absenden", "abschicken", "einreichen"],
      fr: ["envoyer", "soumettre"],
      es: ["enviar"],
      pt: ["enviar", "submeter"],
      it: ["inviare"],
      nl: ["verzenden", "versturen", "indienen"],
    },
  },
  {
    means: "create",
    words: { en: ["create"], de: ["anlegen", "erstellen"], fr: ["créer"], es: ["crear"], pt: ["criar"], it: ["creare", "crea"], nl: ["aanmaken", "creëren"] },
  },
  {
    means: "confirm",
    words: {
      en: ["confirm"],
      de: ["bestätigen", "rückmelden"],
      fr: ["confirmer", "valider"],
      es: ["confirmar"],
      pt: ["confirmar"],
      it: ["confermare", "conferma"],
      nl: ["bevestigen"],
    },
  },
  {
    // German and Spanish use one word for "update" and "refresh" (aktualisieren, actualizar): there it is read as refresh.
    means: "update",
    words: { en: ["update"], de: ["fortschreiben"], fr: ["mettre à jour"], pt: ["atualizar"], it: ["aggiornare", "aggiorna"], nl: ["bijwerken"] },
  },
  {
    means: "change a status",
    words: {
      en: ["change status", "set status", "status change"],
      de: ["status ändern", "status setzen"],
      fr: ["modifier le statut"],
      es: ["modificar status", "modificar estado"],
      pt: ["modificar status"],
      it: ["modificare stato"],
      nl: ["status wijzigen"],
    },
  },
  {
    // Logging off closes the user's sessions; unsaved data is lost.
    means: "log off",
    words: {
      en: ["log off", "logoff", "log out", "logout", "sign out"],
      de: ["abmelden", "abmeldung"],
      fr: ["se déconnecter", "déconnexion", "fermer la session"],
      es: ["cerrar sesión", "salir del sistema"],
      pt: ["encerrar sessão", "efetuar logoff", "terminar sessão"],
      it: ["disconnetti", "disconnettersi", "chiudi sessione"],
      nl: ["afmelden", "uitloggen"],
    },
  },
  {
    means: "complete, publish or load",
    words: {
      en: ["withdraw", "complete", "publish", "upload", "import"],
      de: ["zurückziehen", "abschließen", "veröffentlichen", "hochladen", "importieren"],
      fr: ["retirer", "clôturer", "publier", "télécharger", "importer"],
      es: ["retirar", "completar", "publicar", "cargar", "importar"],
      pt: ["retirar", "concluir", "publicar", "carregar", "importar"],
      it: ["ritirare", "completare", "pubblicare", "caricare", "importare"],
      nl: ["intrekken", "afsluiten", "publiceren", "uploaden", "importeren"],
    },
  },
];

/**
 * "Cancel" alone leaves a screen; "Cancel document", "Annuler la facture"
 * reverse something. A cancel word followed by another word is a commit.
 * (German has two words: "Abbrechen" leaves, "Stornieren" reverses.)
 */
const CANCEL_WORDS = ["cancel", "cancellation", "annuler", "cancelar", "annulla", "annullare", "annuleren"];

/** "Do not save", "Nicht sichern", "Sans enregistrer": the opposite of the word that follows. */
const NEGATION = /(?<![\p{L}\p{N}])(do not|don'?t|without|not|nicht|ohne|ne pas|sans|sin|no|sem|não|senza|non|niet|zonder)\s*$/iu;

export const SAFE_WORDS: WordRow<SafeLanguage>[] = [
  { means: "back", words: { en: ["back"], de: ["zurück"], fr: ["retour"], es: ["atrás", "volver", "regresar"] } },
  {
    means: "exit",
    words: { en: ["exit", "close"], de: ["beenden", "verlassen", "schließen"], fr: ["quitter", "terminer", "fermer"], es: ["salir", "finalizar", "cerrar"] },
  },
  { means: "cancel", words: { en: ["cancel"], de: ["abbrechen"], fr: ["annuler"], es: ["cancelar"] } },
  {
    means: "enter",
    words: { en: ["enter", "continue", "ok"], de: ["weiter", "eingabe", "ok"], fr: ["continuer", "suite", "entrée", "ok"], es: ["continuar", "intro", "ok"] },
  },
  { means: "no", words: { en: ["no"], de: ["nein"], fr: ["non"], es: ["no"] } },
  {
    means: "display",
    words: {
      en: ["display", "show", "hide", "details", "detail", "more", "less"],
      de: ["anzeigen", "einblenden", "ausblenden", "details", "detail", "mehr", "weniger"],
      fr: ["afficher", "masquer", "détails", "détail", "plus", "moins"],
      es: ["visualizar", "mostrar", "ocultar", "detalles", "detalle", "más", "menos"],
    },
  },
  { means: "find", words: { en: ["find", "search"], de: ["suchen", "weitersuchen", "finden"], fr: ["rechercher", "chercher"], es: ["buscar"] } },
  { means: "help", words: { en: ["help"], de: ["hilfe"], fr: ["aide"], es: ["ayuda"] } },
  {
    means: "value help",
    words: {
      en: ["value help", "possible entries", "input help"],
      de: ["wertehilfe", "eingabehilfe", "eingabemöglichkeiten"],
      fr: ["aide à la saisie", "entrées possibles"],
      es: ["ayuda para entradas", "entradas posibles"],
    },
  },
  {
    means: "expand or collapse",
    words: {
      en: ["expand", "collapse"],
      de: ["expandieren", "aufklappen", "zuklappen", "komprimieren", "aufreißen"],
      fr: ["développer", "réduire", "déployer"],
      es: ["expandir", "desplegar", "comprimir", "contraer"],
    },
  },
  { means: "refresh", words: { en: ["refresh"], de: ["aktualisieren", "auffrischen"], fr: ["actualiser", "rafraîchir"], es: ["actualizar", "refrescar"] } },
  {
    means: "next or previous",
    words: {
      en: ["next", "previous", "first page", "last page", "page up", "page down"],
      de: ["nächste", "nächster", "nächstes", "nächsten", "vorige", "voriger", "voriges", "vorigen", "vorherige", "vorheriger", "vorheriges", "vorherigen", "erste seite", "letzte seite"],
      fr: ["suivant", "suivante", "précédent", "précédente", "première page", "dernière page"],
      es: ["siguiente", "anterior", "primera página", "última página"],
    },
  },
  {
    means: "sort",
    words: {
      en: ["sort", "ascending", "descending"],
      de: ["sortieren", "aufsteigend", "absteigend"],
      fr: ["trier", "tri", "croissant", "décroissant"],
      es: ["ordenar", "clasificar", "ascendente", "descendente"],
    },
  },
  { means: "filter", words: { en: ["filter"], de: ["filter", "filtern"], fr: ["filtre", "filtrer"], es: ["filtro", "filtrar"] } },
  {
    means: "print preview",
    words: { en: ["print preview"], de: ["druckvorschau", "druckansicht"], fr: ["aperçu avant impression"], es: ["presentación preliminar", "vista previa"] },
  },
  {
    means: "choose or select",
    words: {
      en: ["choose", "select", "select all", "deselect all"],
      de: ["auswählen", "wählen", "markieren", "entmarkieren"],
      fr: ["sélectionner", "choisir", "désélectionner"],
      es: ["seleccionar", "elegir", "marcar", "desmarcar"],
    },
  },
  { means: "go", words: { en: ["go"], de: ["los"] } },
  {
    means: "SAP Easy Access navigation",
    words: {
      en: ["sap menu", "user menu"],
      de: ["sap menü", "benutzermenü"],
      fr: ["menu sap", "menu utilisateur"],
      es: ["menú sap", "menú de usuario"],
    },
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole words: "post" is not in "postal" or "posting", "save" is not in "unsaved". */
const wholeWords = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(${words.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "giu");

const COMMIT_RE = COMMIT_WORDS.map((row) => ({ means: row.means, re: wholeWords(Object.values(row.words).flat()) }));
const CANCEL_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${CANCEL_WORDS.join("|")})\\s+(?!\\()[\\p{L}]`, "iu");
const SAFE_RE = SAFE_WORDS.map((row) => ({ means: row.means, re: wholeWords(Object.values(row.words).flat()) }));

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** What a text means, if it means a commit: "save", "delete", "cancel a document"... */
export function commitWord(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    const t = clean(text);
    if (!t) continue;
    for (const { means, re } of COMMIT_RE) {
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) if (!NEGATION.test(t.slice(0, m.index))) return means;
    }
    if (CANCEL_RE.test(t)) return "cancel a document";
  }
  return undefined;
}

/**
 * The language of a session as a two-letter code, from what a surface reads:
 * SAP GUI's Info.Language ("EN", or SAP's one-letter "D"), Web GUI's
 * sap-language, UI5's "de-DE". Undefined when it cannot be told.
 */
export function languageCode(raw: string | undefined | null): string | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const one: Record<string, string> = { e: "en", d: "de", f: "fr", s: "es", p: "pt", i: "it", n: "nl" };
  if (s.length === 1) return one[s];
  const m = /^([a-z]{2})(?:[-_][a-z0-9]+)*$/.exec(s);
  return m?.[1];
}

/** Can safe words be trusted for this logon language? Not when the language is unknown. */
export function languageCovered(raw: string | undefined | null): boolean {
  const code = languageCode(raw);
  return !!code && (SAFE_LANGUAGES as readonly string[]).includes(code);
}

/**
 * What a text means, if it is known to be safe: "back", "display", "filter"...
 * Undefined when it holds a commit word, when it holds no safe word, or when
 * the session's language is not covered by SAFE_WORDS.
 */
export function safeWord(language: string | undefined | null, ...texts: (string | undefined)[]): string | undefined {
  if (!languageCovered(language)) return undefined;
  if (commitWord(...texts)) return undefined;
  for (const text of texts) {
    const t = clean(text);
    if (!t) continue;
    for (const { means, re } of SAFE_RE) {
      re.lastIndex = 0;
      if (re.test(t)) return means;
    }
  }
  return undefined;
}

// ---- function keys ------------------------------------------------------------------

/** SAP virtual keys that save on every screen: 11 is Ctrl+S. */
export const SAVE_VKEYS: ReadonlySet<number> = new Set([11]);

/**
 * SAP virtual keys that never write, whatever the screen: 0 Enter, 1 F1 help,
 * 2 F2 choose, 3 F3 back, 4 F4 value help, 12 F12 cancel, 15 Shift+F3 exit,
 * 71 Ctrl+F find, 84 Ctrl+G find next, 80 to 83 paging. A toolbar button
 * `btn[N]` is bound to virtual key N, so these are also the safe button ids.
 *
 * 8 (F8, Execute) is counted safe on purpose: it runs reports and lists
 * (VA05, ME2N, FBL1N...), which read. A report that updates the database
 * usually has a test-run flag and asks before posting, but not always:
 * the README says so, and SAP_BLOCK_TCODES is the tool for known update
 * programs.
 */
export const SAFE_VKEYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 8, 12, 15, 71, 80, 81, 82, 83, 84]);

// ---- function codes -----------------------------------------------------------------

/** Function codes that save, post or delete. Compared with each part of a code ("&DATA_SAVE" -> DATA, SAVE). */
export const COMMIT_CODES: ReadonlySet<string> = new Set([
  ..."SAVE SICH SICHERN BU BUCH BUCHEN POST BOOK UPD UPDA UPDATE DEL DELE DELETE DLT LOE LOES LOESCHEN".split(" "),
  ..."FREI FREIGABE REL RELE RELEASE APPR APPROVE STOR STORNO ACT ACTI ACTIVATE PARK HOLD SEND".split(" "),
]);

/**
 * Function codes that only move or show, compared with the whole code:
 * the standard codes of the system toolbar, and the standard functions of ALV
 * lists and grids (details, sort, filter, find, totals, print preview, views,
 * choosing a layout).
 */
export const SAFE_CODES: ReadonlySet<string> = new Set([
  ..."BACK EXIT CANC RW ABBR ENTR ENTE ENTER E ECAN P+ P++ P- P-- PICK".split(" "),
  ..."&F03 &F12 &F15 &IC1 &ETA &OUP &ODN &ILT &ILD &UMC &SUM &RNT_PREV &ALL &SAL &REFRESH %SC %SC+".split(" "),
  ..."&DETAIL &SORT_ASC &SORT_DSC &FIND &FIND_MORE &MB_FILTER &FILTER &DELETE_FILTER &MB_SUM &SUMC &MB_SUBTOT &SUBTOT".split(" "),
  ..."&PRINT_BACK_PREVIEW &MB_VIEW &VIEW_GRID &MB_VARIANT &COL0 &LOAD &INFO &MB_EXPORT".split(" "),
]);

const bare = (code: string | undefined) => (code ?? "").trim().toUpperCase().replace(/^=/, "");

/** Does a function code save, post or delete? */
export function commitCode(code: string | undefined): boolean {
  if (safeCode(code)) return false;
  return bare(code)
    .replace(/^[&%/]+/, "")
    .split(/[_\-.\s&]+/)
    .some((part) => COMMIT_CODES.has(part));
}

/** Is a function code known to only move or show? */
export function safeCode(code: string | undefined): boolean {
  return SAFE_CODES.has(bare(code));
}

/** Screens where a plain word in the command field is a transaction code, not a function code: SAP Easy Access and the older start menus. */
export const MENU_PROGRAMS: ReadonlySet<string> = new Set(["SAPLSMTR_NAVIGATION", "MENUSYST", "SAPMSYST"]);

/** The program of SAP's logon screen. This server never acts there. */
export const LOGON_PROGRAM = "SAPMSYST";

/**
 * Is this screen SAP's logon (user and password, new password, the notice of
 * a second logon)? Screen 40 of the same program is the old start menu, shown
 * after logon, and is not.
 */
export function isLogonScreen(program: string | undefined, screen: string | number | undefined): boolean {
  return (program ?? "").trim().toUpperCase() === LOGON_PROGRAM && Number(screen) !== 40;
}

export const LOGON_REFUSAL = "This server never logs on; log on yourself, then ask again";

export const CLOSES_SESSIONS = "closes SAP sessions; unsaved data is lost";

/**
 * What an entry in the command field is:
 * - empty: nothing typed, the same as Enter;
 * - key: "/8", the function key with that virtual key number;
 * - transaction: "/nVA03", "/oVA03", "/*VA03", "/n" (back to the menu), "/o" (session list);
 * - closes: "/nex", "/nend", "/i": they close sessions and drop unsaved work;
 * - commit: a function code that saves, posts or deletes;
 * - safe: a function code that only moves;
 * - unknown: anything else ("/h", "/$sync", a function code of the screen, a bare word).
 */
export type Okcode =
  | { kind: "empty" }
  | { kind: "key"; key: number }
  | { kind: "transaction"; tcode: string }
  | { kind: "closes" }
  | { kind: "commit" }
  | { kind: "safe" }
  | { kind: "unknown"; code: string };

export function okcodeKind(value: string | undefined): Okcode {
  const u = (value ?? "").trim().toUpperCase();
  if (!u) return { kind: "empty" };
  const key = /^\/(\d+)$/.exec(u);
  if (key) return { kind: "key", key: Number(key[1]) };
  if (/^\/(NEX|NEND|I\d*)$/.test(u)) return { kind: "closes" };
  const start = /^\/[NO*]\s*([A-Z0-9_/]*)$/.exec(u);
  if (start) return start[1] === "EX" || start[1] === "END" ? { kind: "closes" } : { kind: "transaction", tcode: start[1] ?? "" };
  if (u.startsWith("/")) return { kind: "unknown", code: u };
  if (safeCode(u)) return { kind: "safe" };
  if (commitCode(u)) return { kind: "commit" };
  return { kind: "unknown", code: bare(u) };
}
