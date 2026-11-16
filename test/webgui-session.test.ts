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
