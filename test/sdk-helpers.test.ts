/** The SDK helpers that code made from recordings uses: step, at, popup, button, save, dismissInfo, capture. */
import { describe, expect as bunExpect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTest } from "../src/record/format.js";
import { parseScreen } from "../src/record/screen.js";
import { connect, expect, ExpectError, findButton, isAt, Refused } from "../src/sdk/index.js";
import { FakeSap } from "./record-fakes.js";

const quick = { timeout: 300 };

/** ZA01 filled in up to the availability control screen (quantity above what is available). */
async function atAvailability(fake = new FakeSap()) {
  fake.available = 10;
  const sap = await connect({ surfaces: [fake], write: "on", ...quick });
  await sap.okcode("/nZA01");
  await sap.set("ctxtZORD-KUNNR", "2200");
  await sap.set("txtZORD-MENGE", "50");
  await sap.key("Enter");
  return { sap, fake };
}

describe("sap.step", () => {
  test("names the actions in the history and the trace, and the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sap-step-"));
    const sap = await connect({ surfaces: [new FakeSap()], trace: { dir, name: "steps" }, ...quick });
    const got = await sap.step("Open ZA03", async () => {
      await sap.okcode("/nZA03");
      return 7;
    });
    bunExpect(got).toBe(7);
    const e = await sap
      .step("Display", () =>
        sap.step("Order", async () => {
          await sap.set("ctxtZORD-VBELN", "9999");
          await sap.key(0);
          await expect(sap.status()).toBeSuccess();
        }),
      )
      .catch((x: Error) => x);
    bunExpect(e).toBeInstanceOf(ExpectError);
    // Named once, by the innermost step, with its path.
    bunExpect((e as Error).message).toMatch(/\(in step "Display › Order"\)$/);
    bunExpect((e as Error).message.match(/in step/g)?.length).toBe(1);
    bunExpect(sap.currentStep).toBeUndefined();
    bunExpect(sap.history.map((h) => h.step)).toEqual(["Open ZA03", "Display › Order", "Display › Order"]);
    await sap.okcode("/n");
    const { trace } = await sap.close();
    const t = parseTest(await readFile(trace as string, "utf8"));
    bunExpect(t.steps.map((s) => s.group)).toEqual(["Open ZA03", "Display › Order", "Display › Order", undefined]);
  });
});

describe("sap.at and sap.popup", () => {
  test("at compares the program and the dynpro number as a number", async () => {
    const { sap } = await atAvailability();
    bunExpect(await sap.at("SAPLATP4/0500")).toBe(true);
    bunExpect(await sap.at("SAPLATP4/500")).toBe(true);
    bunExpect(await sap.at("saplatp4")).toBe(true);
    bunExpect(await sap.at({ transaction: "ZA01", screen: "500" })).toBe(true);
    bunExpect(await sap.at("SAPLATP4/0501")).toBe(false);
    bunExpect(await sap.at({ transaction: "ZA03" })).toBe(false);
    bunExpect(isAt(parseScreen("TRANSACTION ZA01  PROGRAM SAPMZA01  SCREEN 100"), {})).toBe(false);
  });
  test("popup gives the popup in front, or undefined", async () => {
    const fake = new FakeSap();
    fake.popupsFor.set("5000", [{ title: "Information", text: "Order has a delivery block" }]);
    const sap = await connect({ surfaces: [fake], ...quick });
    bunExpect(await sap.popup()).toBeUndefined();
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    await sap.key(0);
    bunExpect(await sap.popup()).toEqual({ title: "Information", text: "Order has a delivery block" });
  });
});

describe("sap.button", () => {
  test("presses by label, without the key SAP shows after it, in any case", async () => {
    const { sap, fake } = await atAvailability();
    bunExpect(await sap.button("continue").exists()).toBe(true);
    await sap.button("Continue").press();
    bunExpect(fake.screen).toBe("200");
    bunExpect(fake.acts.at(-1)).toEqual({ do: "press", id: "wnd[0]/tbar[1]/btn[0]" });
  });
  test("the popup in front first", async () => {
    const fake = new FakeSap();
    fake.popupsFor.set("5000", [{ title: "Information", text: "Order has a delivery block" }]);
    const sap = await connect({ surfaces: [fake], ...quick });
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    await sap.key(0);
    await sap.button("Continue").press();
    bunExpect(fake.acts.at(-1)).toEqual({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
    bunExpect(fake.popups).toEqual([]);
  });
  test("refuses a label several buttons have, and says what is there when none has it", async () => {
    const two = parseScreen(['TRANSACTION X  PROGRAM P  SCREEN 1', 'WINDOW wnd[0]  "T"', "wnd[0]/tbar[1]/btn[5]  button  Check (F5)", "wnd[0]/tbar[1]/btn[6]  button  Check (F6)"].join("\n"));
    bunExpect(findButton(two, "Check").several?.map((c) => c.id)).toEqual(["wnd[0]/tbar[1]/btn[5]", "wnd[0]/tbar[1]/btn[6]"]);
    bunExpect(findButton(two, "Check (F6)").control?.id).toBe("wnd[0]/tbar[1]/btn[6]");
    const { sap } = await atAvailability();
    await bunExpect(sap.button("Delivery").press()).rejects.toThrow(/button "Delivery" is not on the screen \(buttons: .*"Delivery proposal \(F7\)"/);
  });
});

describe("sap.save", () => {
  test("acknowledges a warning with Enter when asked", async () => {
    const fake = new FakeSap();
    fake.saveWarning = "Credit limit nearly reached";
    const sap = await connect({ surfaces: [fake], write: "on", ...quick });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    const st = await sap.save({ acceptWarnings: true });
    bunExpect(st).toEqual({ type: "S", text: "Order 5001 has been saved" });
    bunExpect(fake.acts.slice(-2)).toEqual([{ do: "key", key: 11 }, { do: "key", key: 0 }]);
  });
  test("leaves a warning standing without acceptWarnings, and saves at once when there is none", async () => {
    const fake = new FakeSap();
    fake.saveWarning = "Credit limit nearly reached";
    const sap = await connect({ surfaces: [fake], write: "on", ...quick });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    bunExpect((await sap.save()).type).toBe("W");
    fake.saveWarning = undefined;
    const plain = new FakeSap();
    const sap2 = await connect({ surfaces: [plain], write: "on", ...quick });
    await sap2.okcode("/nZA01");
    await sap2.set("ctxtZORD-KUNNR", "2200");
    await sap2.key(0);
    bunExpect(await sap2.save({ acceptWarnings: true })).toEqual({ type: "S", text: "Order 5001 has been saved" });
    bunExpect(plain.acts.at(-1)).toEqual({ do: "key", key: 11 });
  });
  test("goes through the guard", async () => {
    const sap = await connect({ surfaces: [new FakeSap()], write: "off", ...quick });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    await bunExpect(sap.save({ acceptWarnings: true })).rejects.toBeInstanceOf(Refused);
  });
});

describe("sap.dismissInfo", () => {
  test("confirms a popup that only informs; leaves a question and an empty screen alone", async () => {
    const fake = new FakeSap();
    fake.popupsFor.set("5000", [{ title: "Information", text: "Order has a delivery block" }, { title: "Delete?", text: "Delete the order?", question: true }]);
    const sap = await connect({ surfaces: [fake], ...quick });
    bunExpect(await sap.dismissInfo()).toBe(false);
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    await sap.key(0);
    bunExpect(await sap.dismissInfo()).toBe(true);
    bunExpect(fake.popups.map((p) => p.title)).toEqual(["Delete?"]);
    bunExpect(await sap.dismissInfo()).toBe(false);
    bunExpect(fake.popups.map((p) => p.title)).toEqual(["Delete?"]);
  });
});

describe("expect(status).capture", () => {
  test("returns the first group, or the whole match", async () => {
    const sap = await connect({ surfaces: [new FakeSap()], write: "on", ...quick });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    await sap.save();
    bunExpect(await expect(sap.status()).capture(/Order (\d+)/g)).toBe("5001");
    bunExpect(await expect(sap.status()).capture(/\d+/)).toBe("5001");
    const e = await expect(sap.status(), { timeout: 200 })
      .capture(/Invoice (\d+)/)
      .catch((x: Error) => x);
    bunExpect(e).toBeInstanceOf(ExpectError);
    bunExpect((e as Error).message).toContain('capture(/Invoice (\\d+)/): the status bar is S: "Order 5001 has been saved"');
  });
});
