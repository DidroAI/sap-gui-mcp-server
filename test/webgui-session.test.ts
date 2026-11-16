import { describe, expect, test } from "bun:test";
import { carriesStep } from "../src/webgui/session.js";

// Request bodies in the shape Web GUI posts them; the ids are made up.
describe("carriesStep: is a Web GUI request a round trip, or sent on the side", () => {
  test("a key, a button's action, a command: a step", () => {
    expect(carriesStep('[{"content":"/nZT01","post":"okcode/ses[0]"},{"post":"vkey/0/ses[0]"},{"get":"state/ur"}]')).toBe(true);
    expect(carriesStep('[{"content":"1000","post":"value/wnd[1]/usr/ctxtZ-PLANT"},{"post":"action/304/wnd[1]/usr/ctxtZ-PLANT","content":"position=0"}]')).toBe(true);
    expect(carriesStep('[{"post":"action/62/wnd[1]/usr/tblZTC","content":"position=0"}]')).toBe(true);
  });
  test("a field's value for the input history, the focus, the type-ahead: not a step", () => {
    expect(carriesStep('[{"post":"value/wnd[1]/usr/ctxtZ-PLANT","content":"1000","logic":"ignore"}]')).toBe(false);
    expect(carriesStep('[{"post":"focus/wnd[1]/usr/ctxtZ-PLANT","logic":"ignore"},{"post":"typeahead/wnd[1]/usr/ctxtZ-PLANT","content":"10"}]')).toBe(false);
    expect(carriesStep('[{"get":"state/ur"}]')).toBe(false);
  });
  test("a body that cannot be read counts as a step: the wait then errs on the side of waiting", () => {
    expect(carriesStep(null)).toBe(true);
    expect(carriesStep("sap-ext-sid=abc&x=1")).toBe(true);
    expect(carriesStep('{"post":"action/1"}')).toBe(true);
  });
});

describe("closeTypeAhead: closing a type-ahead list keeps the focus in the field", () => {
  const { closeTypeAhead } = require("../src/webgui/session.js") as typeof import("../src/webgui/session.js");
  function page(shown: boolean, tabMovesTo: string) {
    const state = { focus: "field", log: [] as string[] };
    return {
      state,
      io: {
        shown: async () => shown,
        focused: async () => state.focus,
        tab: async () => {
          state.log.push("Tab");
          state.focus = tabMovesTo;
        },
        focus: async (id: string) => {
          state.log.push(`focus ${id}`);
          state.focus = id;
        },
      },
    };
  }
  test("Tab closes the list, then the focus goes back to the field: Enter stays an Enter in the field", async () => {
    const p = page(true, "button-next-to-it");
    expect(await closeTypeAhead(p.io)).toBe(true);
    expect(p.state.log).toEqual(["Tab", "focus field"]);
    expect(p.state.focus).toBe("field");
  });
  test("no list: no key is sent", async () => {
    const p = page(false, "elsewhere");
    expect(await closeTypeAhead(p.io)).toBe(false);
    expect(p.state.log).toEqual([]);
  });
  test("Tab left the focus where it was: nothing more", async () => {
    const p = page(true, "field");
    await closeTypeAhead(p.io);
    expect(p.state.log).toEqual(["Tab"]);
  });
});
