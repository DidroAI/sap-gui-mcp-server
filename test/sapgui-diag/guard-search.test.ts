/**
 * BP's locator "Start" (BUS_LOCA_SRCH01-GO) only runs the search of the Find tab. Scripting and Web GUI
 * take a button named as the start of a search (core/words.ts searchButton) as navigation unless its text
 * says it acts; the DIAG method treated it as a write, and with writes off S/4's MD-03 stopped there
 * (live 2026-11-25). The same rule, by the same SAP name, on the DIAG method. A commit word or a word
 * that acts still wins, and a button named otherwise is still a write.
 */
import { describe, expect, test } from "bun:test";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, resolveTarget } from "../../src/sapgui-diag/index.js";

const el = (e: Partial<DiagElement>): DiagElement => ({ kind: "button", text: "", width: 6, input: true, hidden: false, path: [], etype: 116, row: 6, col: 23, name: "", ...e }) as DiagElement;
const screen = (elements: DiagElement[], language = "E"): DiagScreen =>
  ({ mode: 0, step: 1, session: { system: "S4H", client: "300", user: "U", language, tcode: "BP" }, windows: [{ index: 0, modal: false, title: "Maintain Business Partner", program: "SAPLBUS_LOCATOR", dynpro: "3000", guiStatus: "", guiStatusProgram: "", size: { rows: 17, cols: 124 }, menus: [], toolbar: [], keys: [], elements, tabstrips: [], tables: [], controls: [], containers: [] } as unknown as DiagWindow] }) as DiagScreen;
const assess = (s: DiagScreen, id: string) => assessDiag(s, { do: "press", id }, resolveTarget(s, { do: "press", id }));

describe("a search button by its SAP name", () => {
  test("BP's Start navigates, by function code or name, in any logon language", () => {
    const start = el({ name: "BUS_LOCA_SRCH01-GO", text: "Start", fcode: "BUS_LOCATOR_SRCH_GO" });
    expect(assess(screen([start]), "{BUS_LOCATOR_SRCH_GO}")).toMatchObject({ risk: "navigate", reason: expect.stringContaining("starts a search") });
    expect(assess(screen([start]), "BUS_LOCA_SRCH01-GO").risk).toBe("navigate");
    expect(assess(screen([{ ...start, tooltip: "Suche" }], "D"), "{BUS_LOCATOR_SRCH_GO}").risk).toBe("navigate");
  });
  test("a text that acts or commits wins; other names stay writes", () => {
    expect(assess(screen([el({ name: "Z_PROC-GO", text: "Post", fcode: "ZGO" })]), "{ZGO}").risk).toBe("commit");
    expect(assess(screen([el({ name: "Z_JOB-GO", text: "Execute", fcode: "ZGO" })]), "{ZGO}").risk).toBe("commit");
    expect(assess(screen([el({ name: "BUS_LOCA_SRCH01-CLEAR", text: "Delete Search Field Contents", fcode: "BUS_LOCATOR_SRCH_CLE" })]), "{BUS_LOCATOR_SRCH_CLE}").risk).toBe("commit");
    expect(assess(screen([el({ name: "POST_GO_LIVE", text: "Live", fcode: "ZLIVE" })]), "{ZLIVE}").risk).toBe("commit");
  });
});
