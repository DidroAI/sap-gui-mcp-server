/**
 * A small SAP in memory, read the way the DIAG method reads SAP GUI
 * (SAP_GUI_METHOD=diag): screens are DiagScreen models, the view is
 * src/diag/view.ts's, ids and the guard's rating are src/sapgui-diag's
 * (resolveTarget, assessDiag). Only the keyboard and mouse are faked. Synthetic: no SAP data.
 *
 *   ZA03  display: screen 0100 (order) -> Enter -> screen 0300 with the order's fields,
 *         a checkbox, a button, tabs and an items table; an unknown order stays on 0100
 *         with "E: Order <n> does not exist". F3 goes back to 0100.
 *
 * As on the real method, a typed value reaches SAP (and the view) at the next Enter or function key.
 * Drifts a test can switch on: another field name or screen number, popups after Enter.
 */
import type { DiagElement, DiagKey, DiagScreen, DiagTable, DiagWindow } from "../src/diag/index.js";
import { diagView } from "../src/diag/index.js";
import { type Action, ActionError, type Assessment, type Driver, type SessionInfo, type Surface } from "../src/core/types.js";
import { assessDiag, resolveTarget } from "../src/sapgui-diag/index.js";
import { vkeyNumber } from "../src/sapgui/keys.js";

export interface DiagPopup {
  title: string;
  text: string;
  /** A question with Display {SPOP1} and Cancel {SPOP2}; else an Information popup with Continue (Enter). */
  question?: boolean;
}

const key = (vkey: number, name: string, text: string, fcode?: string): DiagKey => ({ vkey, key: name, text, tooltip: "", icon: "", enabled: true, ...(fcode ? { fcode } : {}) });

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: false, hidden: false, path: [], etype: 130, ...e };
}

function window(over: Partial<DiagWindow> & { title: string; program: string; dynpro: string }): DiagWindow {
  return { index: 0, modal: false, guiStatus: "A", guiStatusProgram: over.program, size: { rows: 20, cols: 100 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [], controls: [], containers: [], ...over };
}

interface Order {
  customer: string;
  net: string;
  material: string;
}

export class FakeDiagSap implements Surface {
  readonly name = "sapgui" as const;
  info: SessionInfo = { id: "sapgui:diag:0:0", surface: "sapgui", method: "diag", system: "XYZ", client: "100", where: "fake DIAG session", transaction: "SMEN", title: "SAP Easy Access" };
  transaction = "SMEN";
  dynpro = "0101";
  status: { type: string; text: string } | undefined;
  /** What SAP has: the field values of the last screen it got. */
  fields: Record<string, string> = {};
  /** Typed, not yet sent: SAP gets it with the next Enter or function key. */
  pending: Record<string, string> = {};
  shown = "";
  tab = "T\\01";
  orders = new Map<string, Order>([["5000", { customer: "2200", net: "1.250,00", material: "M-08" }]]);
  popupsFor = new Map<string, DiagPopup[]>();
  popups: DiagPopup[] = [];
  acts: Action[] = [];
  /** After an Enter, this many looks show the screen marked damaged (bytes lost on the connection). */
  damageAfterEnter = 0;
  private damagedLooks = 0;
  // Drifts.
  /** The initial screen names its order field ZORD-AUFNR. */
  orderField = "ZORD-VBELN";
  /** The overview names the customer field ZORD-KUNAG. */
  customerField = "ZORD-KUNNR";
  /** The overview's screen number. */
  overview = "0300";

  private main(): DiagWindow {
    const keys = [key(3, "F3", "Back", "BACK"), key(12, "F12", "Cancel", "RW"), key(15, "Shift+F3", "Exit", "EXIT")];
    if (this.transaction === "SMEN") return window({ title: "SAP Easy Access", program: "SAPLSMTR_NAVIGATION", dynpro: "0101", keys });
    if (this.dynpro === "0100")
      return window({
        title: "Display Order: Initial Screen",
        program: "SAPMZA03",
        dynpro: "0100",
        keys,
        elements: [el({ kind: "label", name: "TXT_ORDER", text: "Order", row: 2, col: 1, width: 16 }), el({ name: this.orderField, text: this.fields[this.orderField] ?? "", input: true, row: 2, col: 18 })],
        focus: { row: 2, col: 18, name: this.orderField },
      });
    const o = this.orders.get(this.shown) ?? { customer: "", net: "", material: "" };
    const items: DiagTable = {
      name: "TC_ITEMS",
      program: "SAPMZA03",
      title: "All items",
      row: 6,
      col: 0,
      width: 60,
      height: 4,
      path: [],
      totalRows: 1,
      columns: [
        { index: 0, position: 0, name: "ZPOS-POSNR", title: "Item", width: 6, col: 1, visible: true },
        { index: 1, position: 1, name: "ZPOS-MATNR", title: "Material", width: 18, col: 8, visible: true },
        { index: 2, position: 2, name: "ZPOS-MENGE", title: "Quantity", width: 10, col: 27, visible: true },
      ],
      rows: [
        {
          index: 0,
          row: 7,
          empty: false,
          cells: [
            { column: 0, text: "10", kind: "field", input: false, hidden: false },
            { column: 1, text: o.material, kind: "field", input: false, hidden: false },
            { column: 2, text: "2", kind: "field", input: false, hidden: false },
          ],
        },
      ],
    };
    return window({
      title: `Display Order ${this.shown}: Overview`,
      program: "SAPMZA03",
      dynpro: this.overview,
      keys,
      toolbar: [key(5, "F5", "Document flow", "FLOW")],
      elements: [
        el({ kind: "label", name: "TXT_ORDER", text: "Order", row: 0, col: 0, width: 16 }),
        el({ name: "ZORD-VBELN", text: this.shown, row: 0, col: 17 }),
        el({ kind: "label", name: "TXT_NET", text: "Net value", row: 0, col: 40, width: 14 }),
        el({ name: "ZORD-NETWR", text: o.net, row: 0, col: 56 }),
        el({ name: "ZORD-WAERK", text: "EUR", row: 0, col: 70, width: 5 }),
        el({ kind: "label", name: "TXT_CUST", text: "Customer", row: 1, col: 0, width: 16 }),
        el({ name: this.customerField, text: o.customer, row: 1, col: 17 }),
        el({ kind: "checkbox", name: "ZORD-RUSH", text: "Rush order", checked: true, row: 2, col: 1, width: 12 }),
        el({ kind: "button", name: "BT_HEAD", text: "Header", fcode: "HEAD", row: 2, col: 40, width: 8 }),
      ],
      tabstrips: [
        {
          name: "TABS",
          row: 4,
          col: 0,
          width: 60,
          height: 8,
          path: [],
          tabs: [
            { id: "T\\01", name: "TAB1", text: "Sales", fcode: "T\\01", active: this.tab === "T\\01", index: 0, row: 4, col: 1 },
            { id: "T\\02", name: "TAB2", text: "Shipping", fcode: "T\\02", active: this.tab === "T\\02", index: 1, row: 4, col: 8 },
          ],
        },
      ],
      tables: [items],
    });
  }

  screen(): DiagScreen {
    const windows = [this.main()];
    this.popups.forEach((p, i) => {
      const n = this.popups.length - i;
      windows.push(
        window({
          index: n,
          modal: true,
          title: p.title,
          program: "SAPLSPO1",
          dynpro: p.question ? "0500" : "0100",
          size: { rows: 6, cols: 50 },
          position: { row: 5, col: 20 },
          keys: [key(12, "F12", "Cancel", "RW")],
          toolbar: p.question ? [] : [key(0, "Enter", "Continue", "WEIT")],
          elements: [
            el({ kind: "label", name: "TEXT1", text: p.text, row: 1, col: 1, width: 48 }),
            ...(p.question ? [el({ kind: "button", name: "BUTTON_1", text: "Display", fcode: "SPOP1", row: 4, col: 2 }), el({ kind: "button", name: "BUTTON_2", text: "Cancel", fcode: "SPOP2", row: 4, col: 14 })] : []),
          ],
        }),
      );
    });
    windows.splice(1, windows.length - 1, ...windows.slice(1).sort((a, b) => a.index - b.index));
    return { mode: 0, step: 1, session: { system: "XYZ", client: "100", user: "TESTER", language: "E", tcode: this.transaction }, windows, ...(this.status ? { message: this.status } : {}) };
  }

  private send(): void {
    Object.assign(this.fields, this.pending);
    this.pending = {};
  }

  private enter(): void {
    this.send();
    if (this.transaction !== "ZA03" || this.dynpro !== "0100") return;
    const n = this.fields[this.orderField] ?? "";
    if (!this.orders.has(n)) {
      this.status = { type: "E", text: `Order ${n} does not exist` };
      return;
    }
    this.shown = n;
    this.dynpro = this.overview;
    this.popups = [...(this.popupsFor.get(n) ?? [])];
  }

  private runKey(n: number): string {
    const p = this.popups[0];
    if (p) {
      if (n === 12 || (n === 0 && !p.question)) {
        this.popups.shift();
        return `key ${n}`;
      }
      throw new ActionError(`key ${n} does nothing on the popup "${p.title}"`);
    }
    this.status = undefined;
    if (n === 0) {
      this.enter();
      this.damagedLooks = this.damageAfterEnter;
    }
    else if (n === 3 || n === 12) {
      this.send();
      if (this.transaction === "ZA03" && this.dynpro !== "0100") this.dynpro = "0100";
    } else throw new ActionError(`key ${n} is not active on this screen`);
    return `key ${n}`;
  }

  /** What DiagDriver.act does, without the keyboard and mouse. */
  run(a: Action): string {
    this.acts.push(a);
    const s = this.screen();
    if (a.do === "okcode") {
      if (this.popups.length) throw new ActionError("A popup window is open and blocks the command field.");
      this.status = undefined;
      this.pending = {};
      const t = /^\/n(\S*)$/i.exec(String(a.value))?.[1]?.toUpperCase();
      if (t === undefined) throw new ActionError(`unknown command ${String(a.value)}`);
      if (t && t !== "ZA03") {
        this.status = { type: "E", text: `Transaction ${t} does not exist` };
        return `okcode ${a.value}`;
      }
      this.transaction = t || "SMEN";
      this.dynpro = t ? "0100" : "0101";
      this.fields = {};
      this.tab = "T\\01";
      return `okcode ${a.value}`;
    }
    if (a.do === "key") {
      const n = vkeyNumber(a.key ?? a.value);
      if (n === undefined) throw new ActionError(`Unknown key ${String(a.key ?? a.value)}`);
      return this.runKey(n);
    }
    const t = resolveTarget(s, a);
    if (!t) throw new ActionError(`Nothing on the screen matches "${String(a.id ?? a.name ?? "")}": use a field name, {FCODE}, FIELD[n] or @row,col from the view.`);
    if (a.do === "set") {
      if (t.kind !== "element" || !t.element.input) throw new ActionError(`${t.what} is read-only.`);
      this.pending[t.element.name] = String(a.value ?? "");
      return `typed into ${t.what}; SAP gets it with the next Enter or function key`;
    }
    if (t.kind === "key") return this.runKey(t.key.vkey);
    if (t.kind === "tab") {
      this.send();
      this.tab = t.text === "Shipping" ? "T\\02" : "T\\01";
      return `selected ${t.what}`;
    }
    if (t.kind === "element" && t.element.kind === "button") {
      const p = this.popups[0];
      if (p?.question && /^SPOP[12]$/.test(t.element.fcode ?? "")) {
        this.popups.shift();
        return `pressed ${t.what}`;
      }
      this.send();
      return `pressed ${t.what}`;
    }
    throw new ActionError(`cannot ${a.do} ${t.what}`);
  }

  driver(): Driver {
    const self = this;
    return {
      get info() {
        return self.info;
      },
      refresh: async () => {
        self.info = { ...self.info, transaction: self.transaction, title: self.main().title };
        return { ...self.info };
      },
      valid: async () => true,
      look: async (o) => {
        const s = self.screen();
        if (self.damagedLooks > 0) {
          self.damagedLooks--;
          s.damaged = true;
        }
        return diagView(s, o.compact ? {} : { maxRows: 100_000 });
      },
      assess: async (a): Promise<Assessment> => {
        const s = self.screen();
        return assessDiag(s, a, resolveTarget(s, a));
      },
      act: async (a) => {
        const note = self.run(a);
        return self.status ? `${note}; status ${self.status.type}: ${self.status.text}` : note;
      },
      screenshot: async () => Buffer.from("png"),
      close: async () => {},
    };
  }

  async discover(): Promise<SessionInfo[]> {
    return [{ ...this.info }];
  }
  async open(): Promise<Driver> {
    return this.driver();
  }
  async doctor() {
    return [];
  }
}
