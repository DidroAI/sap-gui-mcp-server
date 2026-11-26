/**
 * A value help drawn by a control over the main dynpro gives the screen its caption as title ("Parameters
 * Defining Scope of Purchasing Lists (1)"), while SAP GUI's window keeps the dynpro's own title. Round 1 on S/4
 * (REP-02): every action failed with "No SAP GUI window titled ... is open", the run was stuck. The window is
 * also looked for by the dynpro's title.
 */
import { describe, expect, test } from "bun:test";
import { fakeDriver, screen, sent, win } from "./fake-driver.js";

describe("the session window under a value help's caption", () => {
  test("is found by the dynpro's own title", async () => {
    const s = screen([win({ title: "Parameters Defining Scope of Purchasing Lists (1)", dynproTitle: "Purchasing Documents per Document Number" })]);
    const f = fakeDriver(s, [], "Purchasing Documents per Document Number");
    await f.d.act({ do: "key", key: 12 });
    expect(sent(f)).toEqual(["key"]);
  });
});
