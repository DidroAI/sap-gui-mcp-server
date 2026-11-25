/**
 * Faults first seen on a real SAP GUI (ECC 6.0, SAP GUI 8.00), played here
 * with made-up screens of the same shape. No SAP data.
 */
import { describe, expect, test } from "bun:test";
import type { Control, Screen, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";
import { sapguiSurface } from "../../src/sapgui/index.js";

/** A driver over a host that always shows `screen`, and the actions it was sent. */
async function on(screen: Screen) {
  const acts: unknown[] = [];
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      if (op === "screen") return structuredClone(screen) as T;
      if (op === "describe") return { found: false } as T;
      if (op === "act") {
        acts.push(params.action);
        return { done: true } as T;
      }
      throw new HostError(`UNKNOWN_OP: ${op}`);
    },
    close() {},
  };
  const d = await sapguiSurface({}, { platform: "win32", transport: host }).open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" });
  return { d, acts };
}

const one = (controls: Control[], program = "ZSEL", dynpro = "1000"): Screen => ({
  transaction: "ZT01",
  program,
  screen: dynpro,
  activeWindow: "wnd[0]",
  windows: [{ id: "wnd[0]", title: "Synthetic", controls: [{ id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: "Synthetic" }, ...controls] }],
});

describe("sapgui: a selection screen is no list", () => {
  // SAP GUI gives a selection screen's user area a vertical scrollbar (VA05, MMBE, ME23N: maximum 214, page 571).
  const selection = one([
    { id: "wnd[0]/usr", type: "GuiUserArea", name: "usr", scroll: { position: 0, maximum: 214, pageSize: 571 } },
    { id: "wnd[0]/usr/ctxtSKUNNR-LOW", type: "GuiCTextField", name: "SKUNNR-LOW", text: "", label: "Sold-To Party", changeable: true },
    { id: "wnd[0]/usr/radPVBALL", type: "GuiRadioButton", name: "PVBALL", text: "All", selected: true, changeable: true },
  ]);
  test("its user area gives no list line", async () => {
    const { d } = await on(selection);
    for (const compact of [true, false]) {
      const view = await d.look({ compact });
      expect(view).not.toContain("list");
      expect(view).not.toContain("785");
      expect(view).toContain("SKUNNR-LOW");
    }
  });
  test("scroll without an id finds nothing to scroll, and scroll on usr is refused", async () => {
    const { d, acts } = await on(selection);
    expect(d.act({ do: "scroll", to: "next" })).rejects.toThrow("Nothing on this screen scrolls");
    expect(d.act({ do: "scroll", id: "usr", to: "next" })).rejects.toThrow("does not scroll");
    expect(acts).toEqual([]);
  });
  test("a classic list that scrolls keeps its list line", async () => {
    const list = one(
      [
        { id: "wnd[0]/usr", type: "GuiUserArea", name: "usr", scroll: { position: 0, maximum: 167, pageSize: 34 } },
        { id: "wnd[0]/usr/lbl[1,1]", type: "GuiLabel", name: "", text: "Line one" },
        { id: "wnd[0]/usr/lbl[1,2]", type: "GuiLabel", name: "", text: "Line two" },
      ],
      "SAPMSSY0",
      "120",
    );
    const { d } = await on(list);
    expect(await d.look({ compact: false })).toContain("wnd[0]/usr  list  201 rows (visible 34; scroll for the others)");
  });
});
