import { describe, expect, test } from "bun:test";
import { carriesStep, fromWebGui } from "../src/webgui/session.js";

describe("fromWebGui: which requests the waits count", () => {
  const frame = (url: string, parent: unknown = null) => ({ url: () => url, parentFrame: () => parent });
  const request = (f: unknown, url = "https://h/x") => ({ frame: () => f, url: () => url }) as unknown as Parameters<typeof fromWebGui>[0];
  test("a Web GUI frame's request counts, whatever the case of its path (the classifier gives such a tab to Web GUI)", () => {
    expect(fromWebGui(request(frame("https://h:44300/sap/bc/gui/sap/its/webgui?sap-client=100")))).toBe(true);
    expect(fromWebGui(request(frame("https://h:44300/SAP/BC/GUI/SAP/ITS/WEBGUI?sap-client=100")))).toBe(true);
    // A frame inside one (an HTML viewer) counts too; the launchpad around it does not.
    expect(fromWebGui(request(frame("about:blank", frame("https://h/SAP/bc/gui/sap/its/WebGui"))))).toBe(true);
    expect(fromWebGui(request(frame("https://h/sap/bc/ui2/flp")))).toBe(false);
  });
  test("a request without a frame (a service worker) is judged by its own address", () => {
    const noFrame = (url: string) =>
      ({
        frame: () => {
          throw new Error("no frame");
        },
        url: () => url,
      }) as unknown as Parameters<typeof fromWebGui>[0];
    expect(fromWebGui(noFrame("https://h/SAP/BC/GUI/SAP/ITS/WEBGUI/x.js"))).toBe(true);
    expect(fromWebGui(noFrame("https://h/sap/bc/ui2/flp/x.js"))).toBe(false);
  });
});

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

  test("a dropdown's choice that SAP acts on is a round trip: a value that is not ignored, with a request for the screen", () => {
    expect(carriesStep('[{"post":"focus/wnd[0]/usr/cmbZ-ACTION","logic":"ignore"},{"content":"A04","post":"value/wnd[0]/usr/cmbZ-ACTION"},{"get":"state/ur"}]')).toBe(true);
    // The type-ahead of a field also asks for the screen, but everything it posts is marked "ignore".
    expect(carriesStep('[{"post":"focus/wnd[0]/usr/ctxtZ-ORG","logic":"ignore"},{"post":"typeahead/send","content":"%_SEARCH 1000","logic":"ignore"},{"get":"typeahead/get","logic":"inverse"},{"get":"state/ur"}]')).toBe(false);
    // A value on its own, with no request for the screen, is sent on the side.
    expect(carriesStep('[{"content":"1000","post":"value/wnd[0]/usr/ctxtZ-ORG"}]')).toBe(false);
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
