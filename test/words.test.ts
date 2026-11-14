import { describe, expect, test } from "bun:test";
import { commitCode, commitWord, isLogonScreen, languageCode, languageCovered, okcodeKind, safeCode, safeWord } from "../src/core/words.js";

describe("words: commit", () => {
  test("verbs that write, in seven languages", () => {
    const cases: [string, string][] = [
      ["Save   (Ctrl+S)", "save"],
      ["Sichern", "save"],
      ["Enregistrer", "save"],
      ["Guardar", "save"],
      ["Gravar", "save"],
      ["Salva", "save"],
      ["Opslaan", "save"],
      ["Post", "post"],
      ["Buchen", "post"],
      ["Comptabiliser", "post"],
      ["Boeken", "post"],
      ["Delete   (Shift+F2)", "delete"],
      ["Löschen", "delete"],
      ["Supprimer", "delete"],
      ["Eliminar", "delete"],
      ["Verwijderen", "delete"],
      ["Set deletion flag", "delete"],
      ["Remove", "delete"],
      ["Release", "release"],
      ["Approve", "approve or reject"],
      ["Reverse", "reverse"],
      ["Estornar", "reverse"],
      ["Activate", "activate"],
      ["Create with Reference", "create"],
      ["Anlegen", "create"],
      ["Submit", "send"],
      ["Confirm", "confirm"],
      ["Log Off (Shift+F3)", "log off"],
      ["Sign Out", "log off"],
      ["Abmelden", "log off"],
      ["Cancel document", "cancel a document"],
      ["Annuler la facture", "cancel a document"],
      ["Cancel Order", "cancel a document"],
    ];
    for (const [text, means] of cases) expect([text, commitWord(text)]).toEqual([text, means]);
  });
  test("whole words only, and not after a negation", () => {
    for (const text of ["Cancel", "Cancel   (F12)", "Annuler", "Abbrechen", "Do not save", "Nicht sichern", "Sans enregistrer", "Postal code", "Posting date", "Unsaved", "Display <-> Change", "Execute   (F8)", "Copy   (Enter)", ""])
      expect([text, commitWord(text)]).toEqual([text, undefined]);
    expect(commitWord("Post without reference")).toBe("post");
    expect(commitWord("", "Delete   (Shift+F2)")).toBe("delete");
  });
});

describe("words: safe", () => {
  test("what moves around or only shows, in four languages", () => {
    const cases: [string, string, string][] = [
      ["EN", "Back   (F3)", "back"],
      ["EN", "Exit", "exit"],
      ["EN", "Cancel   (F12)", "cancel"],
      ["EN", "Display document header details", "display"],
      ["EN", "Display <-> Change", "display"],
      ["EN", "Find", "find"],
      ["EN", "Help", "help"],
      ["EN", "Possible entries", "value help"],
      ["EN", "Expand all", "expand or collapse"],
      ["EN", "Refresh", "refresh"],
      ["EN", "Next item", "next or previous"],
      ["EN", "Sort in ascending order", "sort"],
      ["EN", "Set Filter", "filter"],
      ["EN", "Print preview", "print preview"],
      ["EN", "Select all", "choose or select"],
      ["EN", "Go", "go"],
      ["EN", "SAP menu", "SAP Easy Access navigation"],
      ["DE", "Zurück", "back"],
      ["DE", "Anzeigen", "display"],
      ["DE", "Aktualisieren", "refresh"],
      ["de-DE", "Nächste Seite", "next or previous"],
      ["FR", "Afficher", "display"],
      ["FR", "Page suivante", "next or previous"],
      ["ES", "Visualizar", "display"],
      ["S", "Buscar", "find"],
    ];
    for (const [language, text, means] of cases) expect([text, safeWord(language, text)]).toEqual([text, means]);
  });
  test("a commit word wins over a safe word", () => {
    for (const text of ["Save and back", "Display and delete", "Select and release", "Sichern und zurück"]) expect(safeWord("EN", text)).toBeUndefined();
  });
  test("a text nobody knows is not safe", () => {
    for (const text of ["Apply", "Assign", "Execute   (F8)", "Sales", "Print", "Yes", "Related Apps", ""]) expect([text, safeWord("EN", text)]).toEqual([text, undefined]);
  });
  test("in a language the table does not cover, no text is safe", () => {
    for (const language of ["PT", "IT", "NL", "JA", "zh-CN", "", undefined]) {
      expect(languageCovered(language)).toBe(false);
      for (const text of ["Back", "Display", "Voltar", "Exibir", "戻る"]) expect(safeWord(language, text)).toBeUndefined();
    }
    for (const language of ["EN", "en", "en-US", "de_DE", "FR", "es", "E", "D", "F", "S"]) expect([language, languageCovered(language)]).toEqual([language, true]);
    expect(languageCode("en-US")).toBe("en");
    expect(languageCode("P")).toBe("pt");
  });
  test("commit words are read in every language, covered or not", () => {
    expect(commitWord("Gravar")).toBe("save");
    expect(commitWord("Eliminare")).toBe("delete");
    expect(commitWord("Vrijgeven")).toBe("release");
  });
});

describe("words: function codes", () => {
  test("codes that write, by any of their parts", () => {
    for (const code of ["SAVE", "=SICH", "BU", "&DATA_SAVE", "TB_DELETE", "%_GC_DELE", "FREI", "ACTI", "&LOCAL&DELETE_ROW"]) expect([code, commitCode(code)]).toEqual([code, true]);
    for (const code of ["BACK", "ENTR", "&ETA", "VA03", "TB_DETAIL", "&DELETE_FILTER", ""]) expect([code, commitCode(code)]).toEqual([code, false]);
  });
  test("codes that only move or show", () => {
    for (const code of ["BACK", "=BACK", "back", "&ETA", "&MB_FILTER", "&FIND", "&DELETE_FILTER", "&SORT_ASC", "P+"]) expect([code, safeCode(code)]).toEqual([code, true]);
    for (const code of ["YES", "ZZDO", "&DATA_SAVE", "&XXL", "EXEC", ""]) expect([code, safeCode(code)]).toEqual([code, false]);
  });
  test("what an entry in the command field is", () => {
    const kind = (v: string) => okcodeKind(v).kind;
    expect(okcodeKind("/8")).toEqual({ kind: "key", key: 8 });
    expect(okcodeKind(" /nva03 ")).toEqual({ kind: "transaction", tcode: "VA03" });
    for (const v of ["/n", "/o", "/oVA01", "/*VA01", "/n/SAPAPO/SDP94"]) expect([v, kind(v)]).toEqual([v, "transaction"]);
    for (const v of ["/nex", "/NEX", "/nend", "/i", "/i2", "/n ex", " /nEx "]) expect([v, kind(v)]).toEqual([v, "closes"]);
    for (const v of ["SAVE", "=BU", "&DATA_SAVE", "ACTI"]) expect([v, kind(v)]).toEqual([v, "commit"]);
    for (const v of ["BACK", "=ENTR", "&ETA"]) expect([v, kind(v)]).toEqual([v, "safe"]);
    for (const v of ["YES", "ZZDO", "VA03", "/h", "/$sync", "/nVA03 X=1", "&XYZ"]) expect([v, kind(v)]).toEqual([v, "unknown"]);
    expect(kind("")).toBe("empty");
  });
});

describe("words: the logon screen", () => {
  test("program SAPMSYST, but not its start menu (screen 40)", () => {
    expect(isLogonScreen("SAPMSYST", "0020")).toBe(true);
    expect(isLogonScreen("SAPMSYST", 20)).toBe(true);
    expect(isLogonScreen("sapmsyst", "500")).toBe(true);
    expect(isLogonScreen("SAPMSYST", "")).toBe(true);
    expect(isLogonScreen("SAPMSYST", "0040")).toBe(false);
    expect(isLogonScreen("SAPMV45A", "0020")).toBe(false);
    expect(isLogonScreen(undefined, undefined)).toBe(false);
  });
});
