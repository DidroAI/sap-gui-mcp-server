import { describe, expect, test } from "bun:test";
import { gaveUpOn, runningSince, stillRunning } from "../src/webgui/running.js";
import type { WebGuiSession } from "../src/webgui/session.js";

const session = () => ({ page: {} }) as unknown as WebGuiSession;

describe("a step that outlasted its action", () => {
  test("no step given up on: nothing to say, whatever the lock", () => {
    const s = session();
    expect(stillRunning(s, true)).toBeUndefined();
    expect(runningSince(s)).toBe("");
  });

  test("while Web GUI is locked, the next action is refused at once and told what runs, since when, and that it cannot be cancelled", () => {
    const s = session();
    gaveUpOn(s, "key 8", 1_000);
    expect(stillRunning(s, true, 24_400)).toBe(
      "SAP is still working on the step sent 23 s ago (key 8), so nothing was done. Web GUI cannot cancel a running step. Look again in a moment (sap_look): the screen of that step comes when it ends. To give the step up, the SAP session has to be ended (logged off and on again by whoever logs this session on); unsaved input is then lost.",
    );
    expect(runningSince(s, 24_400)).toBe(" The step (key 8) was sent 23 s ago. Web GUI cannot cancel a running step.");
  });

  test("once the lock is gone the step is over and forgotten", () => {
    const s = session();
    gaveUpOn(s, "key 8", 1_000);
    expect(stillRunning(s, false, 30_000)).toBeUndefined();
    expect(stillRunning(s, true, 31_000)).toBeUndefined();
    // A Web GUI that does not say whether it is locked: the action's own wait decides, as before.
    gaveUpOn(s, "key 8", 1_000);
    expect(stillRunning(s, undefined, 5_000)).toBeUndefined();
  });
});
