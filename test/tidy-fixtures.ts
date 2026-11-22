/**
 * Recordings made the way an agent makes them, on the fake SAP of
 * record-fakes.ts: for the tidy tests and the code tools.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { normalizeAction } from "../src/core/action.js";
import type { Action, Driver } from "../src/core/types.js";
import type { SapTest } from "../src/record/format.js";
import { Recorder } from "../src/record/recorder.js";
import { FakeSap } from "./record-fakes.js";

/** A fake with the quirks of a real system: the availability screen above 10 pieces, a warning at save, an Information popup on order 5001. */
export function quirkyFake(): FakeSap {
  const f = new FakeSap();
  f.available = 10;
  f.saveWarning = "Credit limit nearly reached";
  f.popupsFor.set("5001", [{ title: "Information", text: "Order has a delivery block" }]);
  return f;
}

export interface Rec {
  recorder: Recorder;
  driver: Driver;
  fake: FakeSap;
  /** Runs an action and records it, as the server does around sap_act. An action that fails is not recorded and does not throw here. */
  act(a: Action): Promise<void>;
}

export async function recording(name: string, fake: FakeSap): Promise<Rec> {
  const dir = await mkdtemp(`${tmpdir()}/sap-tidy-`);
  const recorder = new Recorder({ dir, auto: false, by: "test" });
  const driver = await fake.open();
  await recorder.start(driver, driver.info, name);
  return {
    recorder,
    driver,
    fake,
    act: async (a) => {
      const action = normalizeAction(a);
      const risk = (await driver.assess(action)).risk;
      await recorder.act(driver, action, risk, () => driver.act(action)).catch(() => {});
    },
  };
}

/**
 * The messy run (23 steps): wrong transactions first, a forgotten required
 * field, a typo corrected, a checkbox toggled back and forth, the
 * availability screen, a save that warns, then the display with its
 * Information popup and tabs clicked to and fro. Checks and a capture as an
 * agent marks them.
 */
export async function messyRun(fake = quirkyFake()): Promise<SapTest> {
  const r = await recording("messy create", fake);
  const { act, recorder, driver } = r;
  await act({ do: "okcode", value: "/nZA02" }); // no such transaction: E
  await act({ do: "okcode", value: "/nZA03" }); // display, not create
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-VBELN", value: "1" });
  await act({ do: "key", key: 0 }); // E: Order 1 does not exist
  await act({ do: "okcode", value: "/nZA01" });
  await act({ do: "set", id: "wnd[0]/usr/txtZORD-MENGE", value: "50" });
  await act({ do: "key", key: 0 }); // E: Fill in all required fields
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-KUNNR", value: "220" }); // typo
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-KUNNR", value: "2200" });
  await act({ do: "check", id: "wnd[0]/usr/chkZORD-RUSH", value: true });
  await act({ do: "check", id: "wnd[0]/usr/chkZORD-RUSH", value: false });
  await act({ do: "check", id: "wnd[0]/usr/chkZORD-RUSH", value: true });
  await act({ do: "key", key: 0 }); // the availability control screen
  await act({ do: "set", id: "wnd[0]/usr/txtZORD-MENGE", value: "5" }); // read-only there: fails, not recorded
  await act({ do: "press", id: "wnd[0]/tbar[1]/btn[0]" }); // Continue
  await act({ do: "key", key: 11 }); // W: Credit limit nearly reached
  await act({ do: "key", key: 0 }); // saved
  await recorder.capture(driver, { name: "order", from: "status", pattern: "Order (\\d+)" });
  await act({ do: "okcode", value: "/nZA03" });
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-VBELN", value: "5001" });
  await act({ do: "key", key: 0 }); // the Information popup
  await act({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
  await act({ do: "select", id: "wnd[0]/usr/tabsTS/tabpT\\02" });
  await act({ do: "select", id: "wnd[0]/usr/tabsTS/tabpT\\01" });
  await act({ do: "select", id: "wnd[0]/usr/tabsTS/tabpT\\02" });
  await recorder.assert(driver, { check: "field", id: "wnd[0]/usr/subHEAD:SAPMZA03:0301/ctxtZORD-KUNNR" });
  await recorder.assert(driver, { check: "field", id: "wnd[0]/usr/tabsTS/tabpT\\02/tblITEMS/txtZPOS-MENGE[2,0]" });
  return (await recorder.stop()).test;
}

/** An agent that marks nothing: create an order, then display it by its number. */
export async function unmarkedRun(fake = new FakeSap()): Promise<SapTest> {
  fake.next = 19097;
  const { act, recorder } = await recording("unmarked create", fake);
  await act({ do: "okcode", value: "/nZA01" });
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-KUNNR", value: "2200" });
  await act({ do: "set", id: "wnd[0]/usr/txtZORD-MENGE", value: "3" });
  await act({ do: "key", key: 0 });
  await act({ do: "key", key: 11 });
  await act({ do: "okcode", value: "/nZA03" });
  await act({ do: "set", id: "wnd[0]/usr/ctxtZORD-VBELN", value: "19097" });
  await act({ do: "key", key: 0 });
  return (await recorder.stop()).test;
}
