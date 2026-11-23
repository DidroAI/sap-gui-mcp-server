import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { commandFieldRefusal, currentTcode, decide, isCommandField, leavesTransaction, okcodeKind, policyFromEnv, sessionRefusal, systemAllowed, tcodeOf } from "../src/core/guard.js";

describe("guard", () => {
  test("writes are off by default", () => {
    const p = policyFromEnv({});
    expect(decide(p, { do: "key", key: 11 }, { risk: "commit", reason: "Save" })).toMatchObject({ run: false });
    expect(decide(p, { do: "set", id: "x", value: "1" }, { risk: "navigate", reason: "" })).toEqual({ run: true });
  });
  test("confirm mode holds commits", () => {
    const v = decide(policyFromEnv({ SAP_WRITE: "confirm" }), { do: "key", key: 11 }, { risk: "commit", reason: "Save" });
    expect(v).toEqual({ run: false, confirm: "Save" });
  });
  test("okcode transactions follow allow and block lists", () => {
    expect(tcodeOf({ do: "okcode", value: "/nva01" })).toBe("VA01");
    expect(tcodeOf({ do: "okcode", value: "/11" })).toBeUndefined();
    const p = policyFromEnv({ SAP_BLOCK_TCODES: "SE38,SM30" });
    expect(decide(p, { do: "okcode", value: "/nSE38" }, { risk: "navigate", reason: "" })).toMatchObject({ run: false });
  });
  test("system allow list with client", () => {
    const p = policyFromEnv({ SAP_ALLOW_SYSTEMS: "ABA/800" });
    expect(systemAllowed(p, { id: "1", surface: "webgui", where: "", system: "ABA", client: "800" })).toBe(true);
    expect(systemAllowed(p, { id: "1", surface: "webgui", where: "", system: "ABA", client: "100" })).toBe(false);
    expect(systemAllowed(p, { id: "1", surface: "webgui", where: "" })).toBe(false);
  });
});

describe("okcodes", () => {
  test("every way to open a transaction is read", () => {
    for (const [v, t] of [
      ["/nVA01", "VA01"],
      ["/oVA01", "VA01"],
      ["/OVA01", "VA01"],
      ["/*VA01", "VA01"],
      ["/*va01 VBAK-AUART=OR;", "VA01"],
      ["/n va01", "VA01"],
      ["  /nSE38  ", "SE38"],
      ["/n/SAPAPO/SDP94", "/SAPAPO/SDP94"],
      ["SE38", "SE38"],
    ] as const)
      expect([v, tcodeOf({ do: "okcode", value: v })]).toEqual([v, t]);
  });
  test("closing sessions is not a transaction", () => {
    for (const v of ["/nex", "/nEND", "/NEX", "/i", "/i3", "/I"]) {
      expect([v, okcodeKind(v)]).toEqual([v, { kind: "close" }]);
      expect(tcodeOf({ do: "okcode", value: v })).toBeUndefined();
    }
    // Lists do not refuse them: the surface's rules decide.
    const p = policyFromEnv({ SAP_ALLOW_TCODES: "VA03" });
    expect(decide(p, { do: "okcode", value: "/nex" }, { risk: "navigate", reason: "" })).toEqual({ run: true });
  });
  test("commands that open nothing", () => {
    for (const v of ["/n", "/o", "/11", "/00", "/h", "=SAVE", "%pc", "", "11"]) expect([v, okcodeKind(v).kind]).toEqual([v, "other"]);
    expect(okcodeKind(11).kind).toBe("other");
  });
  test("the lists apply to /* and /o and to namespaced transactions", () => {
    const p = policyFromEnv({ SAP_BLOCK_TCODES: "SE38,/SAPAPO/SDP94" });
    for (const v of ["/*SE38", "/oSE38", "/ose38", "/n/sapapo/sdp94"])
      expect([v, decide(p, { do: "okcode", value: v }, { risk: "navigate", reason: "" })]).toEqual([v, { run: false, refused: expect.stringContaining("blocked") }]);
    const allow = policyFromEnv({ SAP_ALLOW_TCODES: "VA03" });
    expect(decide(allow, { do: "okcode", value: "/*VA01" }, { risk: "navigate", reason: "" })).toMatchObject({ run: false });
    expect(decide(allow, { do: "okcode", value: "/*VA03" }, { risk: "navigate", reason: "" })).toEqual({ run: true });
  });
});

describe("the command field", () => {
  test("is recognised in every spelling", () => {
    for (const id of ["okcd", "wnd[0]/tbar[0]/okcd", "tbar[0]/okcd", "/app/con[0]/ses[0]/wnd[0]/tbar[0]/okcd", "wnd[1]/tbar[0]/okcd", " OKCD ", "#ToolbarOkCode", "ToolbarOkCode", "okcode"])
      expect([id, isCommandField(id)]).toEqual([id, true]);
    for (const id of ["ctxtVBAK-AUART", "wnd[0]/usr/txtOKCD_TEXT", "btn[8]", "", undefined, 3]) expect([id, isCommandField(id)]).toEqual([id, false]);
  });
  test("set, focus, dblclick and the rest are refused there; okcode is the way", () => {
    const p = policyFromEnv({ SAP_WRITE: "on" });
    for (const verb of ["set", "focus", "dblclick", "press", "click", "combo", "f4", "select"]) {
      const a = normalizeAction({ do: verb, id: "wnd[0]/tbar[0]/okcd", value: "/nSE38" });
      expect(commandFieldRefusal(a)).toContain('{"do":"okcode"');
      expect(decide(p, a, { risk: "navigate", reason: "" })).toMatchObject({ run: false, refused: expect.stringContaining("command field") });
    }
    expect(commandFieldRefusal(normalizeAction({ do: "okcode", value: "/nVA03" }))).toBeUndefined();
    expect(commandFieldRefusal(normalizeAction({ do: "set", id: "ctxtVBAK-AUART", value: "OR" }))).toBeUndefined();
    // A line break does not hide the id.
    expect(commandFieldRefusal(normalizeAction({ do: "set", id: "okcd\n", value: "x" }))).toBeDefined();
  });
});

describe("the transaction a session is in", () => {
  test("is read as the lists spell it", () => {
    expect(currentTcode({ transaction: "VA01 (start)" })).toBe("VA01");
    expect(currentTcode({ transaction: "se38" })).toBe("SE38");
    expect(currentTcode({})).toBeUndefined();
  });
  test("block list, allow list, and the start screens", () => {
    const block = policyFromEnv({ SAP_BLOCK_TCODES: "SE38" });
    expect(sessionRefusal(block, { transaction: "SE38" })).toContain("blocked");
    expect(sessionRefusal(block, { transaction: "VA03" })).toBeUndefined();
    const allow = policyFromEnv({ SAP_ALLOW_TCODES: "VA03" });
    expect(sessionRefusal(allow, { transaction: "MM03" })).toContain("SAP_ALLOW_TCODES");
    expect(sessionRefusal(allow, { transaction: "VA03" })).toBeUndefined();
    expect(sessionRefusal(allow, { transaction: "SESSION_MANAGER" })).toBeUndefined();
    expect(sessionRefusal(allow, {})).toBeUndefined();
    // A start screen can still be blocked by name.
    expect(sessionRefusal(policyFromEnv({ SAP_BLOCK_TCODES: "SMEN" }), { transaction: "SMEN" })).toContain("blocked");
  });
  test("what leaves a transaction", () => {
    const p = policyFromEnv({ SAP_BLOCK_TCODES: "SE38" });
    expect(leavesTransaction(p, { do: "okcode", value: "/n" })).toBe(true);
    expect(leavesTransaction(p, { do: "okcode", value: "/nVA03" })).toBe(true);
    expect(leavesTransaction(p, { do: "okcode", value: "/nex" })).toBe(true);
    expect(leavesTransaction(p, { do: "okcode", value: "/nSE38" })).toBe(false);
    expect(leavesTransaction(p, { do: "okcode", value: "/oVA03" })).toBe(false);
    expect(leavesTransaction(p, { do: "okcode", value: "=SAVE" })).toBe(false);
    expect(leavesTransaction(p, { do: "key", key: 3 })).toBe(false);
  });
});

describe("a second write refusal in a session is one line", () => {
  test("the first says it all; the next one the rule only (live 2026-11-23: 600 characters each time)", () => {
    const policy = policyFromEnv({});
    const action = normalizeAction({ do: "key", key: 11 });
    const assessment = { risk: "commit" as const, reason: "key 11 is Save" };
    const first = decide(policy, action, assessment);
    const again = decide(policy, action, assessment, true);
    if (first.run || !("refused" in first) || again.run || !("refused" in again)) throw new Error("not refused");
    expect(first.refused).toContain("SAP_WRITE=confirm or on");
    expect(again.refused).toBe('this action may write to SAP (key 11 is Save) and writes are off. As before: tell the user, leave without saving ({"do":"okcode","value":"/n"}), do not look for another way.');
    expect(again.refused.length).toBeLessThan(first.refused.length / 2);
  });
});
