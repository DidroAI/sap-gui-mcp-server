/**
 * A small SAP in memory for the record and replay tests: two transactions
 * with screens in the view format of SAP GUI and Web GUI. Synthetic: no SAP data.
 *
 *   ZA01  create: screen 100 (customer, quantity, a checkbox) -> Enter -> screen 200 -> key 11 saves:
 *         back on 100 with "S: Order <n> has been saved"
 *   ZA03  display: screen 100 (order) -> Enter -> screen 300 with the order's fields, two tabs and a table;
 *         an unknown order stays on 100 with "E: Order <n> does not exist"
 */
import type { Action, Assessment, Driver, SessionInfo, Surface, SurfaceName } from "../src/core/types.js";
import { ActionError } from "../src/core/types.js";

export interface Popup {
  title: string;
  text: string;
  question?: boolean;
}

interface Order {
  customer: string;
  quantity: string;
  rush: boolean;
}

export class FakeSap implements Surface {
  readonly name: SurfaceName;
  info: SessionInfo;
  transaction = "SMEN";
  screen = "100";
  status = "";
  fields: Record<string, string> = {};
  rush = false;
  tab = "T\\01";
  orders = new Map<string, Order>([["5000", { customer: "2200", quantity: "2", rush: true }]]);
  next = 5001;
  shown: string | undefined;
  /** Set to wrap the order screen's fields in another subscreen, as a changed screen would. */
  moved = false;
  acts: Action[] = [];
  /** Popups SAP shows after Enter on an order in ZA03, by order: an Information popup is text and Continue, a question has Yes and No. */
  popupsFor = new Map<string, Popup[]>();
  /** The popups open now, the one in front first. */
  popups: Popup[] = [];
  /** After an action, this many looks still show the screen from before it, with the note that SAP is still working. */
  lag = 0;
  private stale: { view: string; left: number } | undefined;
  /** ZA01: a quantity above this shows the availability control screen after Enter. */
  available = Number.POSITIVE_INFINITY;

  constructor(name: SurfaceName = "webgui", system = "ABA") {
    this.name = name;
    this.info = { id: "fake:1", surface: name, system, client: "800", where: "fake session", transaction: "SMEN", title: "SAP Easy Access" };
  }

  private program(): string {
    if (this.popups[0]) return this.popups[0].question ? "SAPLSPO1" : `SAPMZ${this.transaction.slice(1)}`;
    if (this.screen === "500") return "SAPLATP4";
    return this.transaction === "SMEN" ? "SAPLSMTR_NAVIGATION" : `SAPMZ${this.transaction.slice(1)}`;
  }

  private screenNo(): string {
    if (this.popups[0]) return this.popups[0].question ? "0500" : "102";
    return this.screen;
  }

  private title(): string {
    if (this.transaction === "SMEN") return "SAP Easy Access";
    if (this.transaction === "ZA01") return this.screen === "100" ? "Create Order: Initial Screen" : this.screen === "500" ? "Create Order: Availability Control" : "Create Order: Overview";
    return this.screen === "100" ? "Display Order: Initial Screen" : `Display Order ${this.shown}: Overview`;
  }

  view(): string {
    const out = [`TRANSACTION ${this.transaction}  PROGRAM ${this.program()}  SCREEN ${this.screenNo()}  SYSTEM ${this.info.system} (800)`, `WINDOW wnd[0]  "${this.title()}"`, "wnd[0]/tbar[0]/okcd  command-field", "wnd[0]/tbar[0]/btn[3]  button  Back (F3)"];
    const f = (id: string, label: string, edit = true) => out.push(`wnd[0]/usr/${id}  field  ${label} = "${this.fields[id.slice(id.lastIndexOf("/") + 1)] ?? ""}"  (${edit ? "edit" : "read-only"})`);
    if (this.transaction === "ZA01" && this.screen === "100") {
      f("ctxtZORD-KUNNR", "Customer");
      f("txtZORD-MENGE", "Quantity");
      out.push(`wnd[0]/usr/chkZORD-RUSH  checkbox  [${this.rush ? "x" : " "}] Rush order`);
    } else if (this.transaction === "ZA01" && this.screen === "500") {
      out.push("wnd[0]/tbar[1]/btn[7]  button  Delivery proposal (F7)");
      out.push("wnd[0]/tbar[1]/btn[0]  button  Continue (Enter)");
      out.push(`wnd[0]/usr/txtZORD-MENGE  field  Order quantity = "${this.fields["txtZORD-MENGE"] ?? ""}"  (read-only)`);
    } else if (this.transaction === "ZA01") {
      f("ctxtZORD-KUNNR", "Customer", false);
      out.push("wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)");
    } else if (this.transaction === "ZA03" && this.screen === "100") f("ctxtZORD-VBELN", "Order");
    else if (this.transaction === "ZA03") {
      const o = this.orders.get(this.shown ?? "") as Order;
      const sub = this.moved ? "subNEW:SAPMZA03:0310/" : "subHEAD:SAPMZA03:0301/";
      out.push(`wnd[0]/usr/${sub}ctxtZORD-VBELN  field  Order = "${this.shown}"  (read-only)`);
      out.push(`wnd[0]/usr/${sub}ctxtZORD-KUNNR  field  Customer = "${o.customer}"  (read-only)`);
      out.push(`wnd[0]/usr/${sub}chkZORD-RUSH  checkbox  [${o.rush ? "x" : " "}] Rush order`);
      out.push(`wnd[0]/usr/tabsTS/tabpT\\01  tab  Sales${this.tab === "T\\01" ? " (selected)" : ""}`);
      out.push(`wnd[0]/usr/tabsTS/tabpT\\02  tab  Items${this.tab === "T\\02" ? " (selected)" : ""}`);
      if (this.tab === "T\\02") {
        out.push("wnd[0]/usr/tabsTS/tabpT\\02/tblITEMS  table  rows 1 (visible 5); columns: Item | Material | Quantity");
        out.push('wnd[0]/usr/tabsTS/tabpT\\02/tblITEMS/txtZPOS-POSNR[0,0]  field   = "10"  (read-only)');
        out.push(`wnd[0]/usr/tabsTS/tabpT\\02/tblITEMS/txtZPOS-MENGE[2,0]  field   = "${o.quantity}"  (read-only)`);
      }
    }
    if (this.status) out.push(`wnd[0]/sbar  status  ${this.status}`);
    const p = this.popups[0];
    if (p) {
      out.push(`WINDOW wnd[1]  "${p.title}"`, `wnd[1]/usr/txtMESSTXT1  label  ${p.text}`);
      if (p.question) out.push("wnd[1]/usr/btnSPOP-OPTION1  button  Yes", "wnd[1]/usr/btnSPOP-OPTION2  button  No");
      else out.push("wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)");
    }
    return out.join("\n");
  }

  private find(id: string): string {
    const ids = this.view()
      .split("\n")
      .map((l) => l.split("  ")[0] ?? "");
    const hit = ids.find((x) => x === id) ?? ids.find((x) => x.endsWith(`/${id}`));
    if (!hit) throw new ActionError(`no control named ${id}`);
    return hit;
  }

  private run(a: Action): string {
    this.acts.push(a);
    const p = this.popups[0];
    if (p) {
      // A popup takes the keys and its own buttons; everything else waits behind it.
      if (a.do === "okcode") throw new ActionError("A popup window is open and blocks the command field: answer or close the popup first.");
      if (a.do === "key" && a.key === 12) {
        this.popups = [];
        return "key Escape";
      }
      if ((a.do === "key" && a.key === 0 && !p.question) || (a.do === "press" && a.id === "wnd[1]/tbar[0]/btn[0]" && !p.question) || (a.do === "press" && /SPOP-OPTION/.test(String(a.id)) && p.question)) {
        this.popups.shift();
        return `pressed ${a.id ?? "Enter"}`;
      }
      throw new ActionError(`cannot ${a.do} ${a.id ?? ""} while the popup "${p.title}" is open`);
    }
    this.status = "";
    if (a.do === "okcode") {
      const t = /^\/n(\S*)$/i.exec(String(a.value))?.[1]?.toUpperCase();
      if (t === undefined) throw new ActionError(`unknown command ${String(a.value)}`);
      if (t && t !== "ZA01" && t !== "ZA03") {
        this.status = `E: Transaction ${t} does not exist`;
        return `okcode ${a.value}`;
      }
      this.transaction = t || "SMEN";
      this.screen = "100";
      this.fields = {};
      this.rush = false;
      this.tab = "T\\01";
      return `okcode ${a.value}`;
    }
    if ((a.do === "key" && a.key === 0) || (a.do === "press" && a.id === "wnd[0]/tbar[1]/btn[0]" && this.screen === "500")) {
      if (this.transaction === "ZA01" && this.screen === "500") this.screen = "200";
      else if (this.transaction === "ZA01" && this.screen === "100") {
        if (!this.fields["ctxtZORD-KUNNR"]) this.status = "E: Fill in all required fields";
        else if (Number(this.fields["txtZORD-MENGE"] ?? 0) > this.available) this.screen = "500";
        else this.screen = "200";
      } else if (this.transaction === "ZA03" && this.screen === "100") {
        const n = this.fields["ctxtZORD-VBELN"] ?? "";
        if (this.orders.has(n)) {
          this.shown = n;
          this.screen = "300";
          this.popups = [...(this.popupsFor.get(n) ?? [])];
        } else this.status = `E: Order ${n} does not exist`;
      }
      return "key Enter";
    }
    if (a.do === "key" && a.key === 3) {
      this.screen = "100";
      return "key F3";
    }
    if (a.do === "key" && a.key === 11) {
      if (this.transaction !== "ZA01" || this.screen !== "200") throw new ActionError("nothing to save here");
      const n = String(this.next++);
      this.orders.set(n, { customer: this.fields["ctxtZORD-KUNNR"] ?? "", quantity: this.fields["txtZORD-MENGE"] ?? "", rush: this.rush });
      this.screen = "100";
      this.fields = {};
      this.status = `S: Order ${n} has been saved`;
      return "key Control+s";
    }
    const id = this.find(String(a.id ?? ""));
    const seg = id.slice(id.lastIndexOf("/") + 1);
    if (a.do === "set") {
      if (this.view().includes(`${id}  field`) && this.view().split("\n").find((l) => l.startsWith(`${id}  `))?.endsWith("(read-only)")) throw new ActionError(`${id} is read-only`);
      this.fields[seg] = String(a.value ?? "");
      return `set ${id}`;
    }
    if (a.do === "check") {
      this.rush = a.value !== false;
      return `${id} checked`;
    }
    if (a.do === "select") {
      this.tab = seg.replace(/^tabp/, "");
      return `selected ${id}`;
    }
    throw new ActionError(`cannot ${a.do} ${id}`);
  }

  driver(): Driver {
    const refresh = async (): Promise<SessionInfo> => {
      this.info = { ...this.info, transaction: this.transaction, title: this.title() };
      return { ...this.info };
    };
    const self = this;
    return {
      get info() {
        return self.info;
      },
      refresh,
      valid: async () => true,
      look: async () => {
        if (this.stale && this.stale.left-- > 0) return `${this.stale.view}\nNOTE SAP is still working on a step (Web GUI has locked the page until its answer is drawn): this screen is from before that step and will change.`;
        return this.view();
      },
      assess: async (a): Promise<Assessment> => (a.do === "key" && a.key === 11 ? { risk: "commit", reason: "key 11: Save" } : { risk: "navigate", reason: a.do }),
      act: async (a) => {
        const view = this.view();
        const note = this.run(a);
        if (this.lag) this.stale = { view, left: this.lag };
        return note;
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
