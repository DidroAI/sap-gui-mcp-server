import { describe, expect, test } from "bun:test";
import { decide, policyFromEnv, systemAllowed, tcodeOf } from "../src/core/guard.js";

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
  });
});
