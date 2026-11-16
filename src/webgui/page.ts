/**
 * The functions of the Web GUI reader that run inside the page
 * (frame.evaluate). Each one is self-contained: it closes over nothing in
 * this module, because Playwright sends its source text to the browser.
 *
 * Web GUI replaces `String.prototype.trim` with a regex that backtracks for
 * minutes on long text, and Web GUI of S/4HANA 2025 breaks
 * `String.prototype.matchAll`: this code calls neither.
 *
 * Web GUI writes each control's SAP GUI scripting id and type into `lsdata`
 * (`{SID:'wnd[0]/usr/ctxtVBAK-AUART',Type:'GuiCTextField',ModalNo:0}`), so
 * the ids are those of SAP GUI for Windows. What scripting reads through
 * methods (tree nodes, ALV cells, value-help rows, the menu bar) is read
 * from the rendered page.
 */

export interface LookResult {
  transaction: string;
  program: string;
  /** System, client and server, from the status bar's information area. */
  system: string;
  screen: string;
  windows: { id: string; title: string; lines: string[] }[];
}

/** The full read of one Web GUI frame: every control as a line, by window. */
export function extractLook(limits: {
  grid: number;
  tree: number;
}): LookResult {
  // Web GUI of S/4HANA 2025 breaks String.prototype.matchAll (as Web GUI breaks trim): loop with exec.
  const execAll = (text: string, re: RegExp): RegExpExecArray[] => {
    const out: RegExpExecArray[] = [];
    const g = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`,
    );
    for (let m = g.exec(text); m; m = g.exec(text)) out.push(m);
    return out;
  };
  const norm = (s: string | null | undefined) => {
    const t = (s ?? "").replace(/[\s\u00a0]+/g, " ");
    return t.slice(
      t.startsWith(" ") ? 1 : 0,
      t.endsWith(" ") ? t.length - 1 : t.length,
    );
  };
  const unesc = (s: string) =>
    s
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/\\(.)/g, "$1");
  const prop = (ls: string, key: number | string): string => {
    const m = new RegExp(`(?:^|[{,])${key}:'((?:[^'\\\\]|\\\\.)*)'`).exec(ls);
    return m ? unesc(m[1] ?? "") : "";
  };
  const info = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? "";
    const raw =
      /OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1];
    const type = /[{,]Type:'([^']*)'/.exec(ls)?.[1] ?? "";
    // lsdata escapes a backslash twice (tabpT\\08 is the id tabpT\08).
    // S/4HANA 2025 writes ModalNo only on the window itself: a control's window is then the one its id names.
    return {
      ls,
      sid: raw ? raw.replace(/\\\\/g, "\\") : "",
      type,
      modal: Number(/ModalNo:(\d+)/.exec(ls)?.[1] ?? /^wnd\[(\d+)\]/.exec(raw ?? "")?.[1] ?? 0),
    };
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if ((el as HTMLElement).checkVisibility?.() === false) return false;
    return true;
  };
  const inView = (el: Element, box?: DOMRect) => {
    const r = el.getBoundingClientRect();
    if (
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= innerHeight ||
      r.left >= innerWidth
    )
      return false;
    if (
      box &&
      (r.bottom <= box.top + 2 ||
        r.top >= box.bottom - 2 ||
        r.right <= box.left + 2 ||
        r.left >= box.right - 2)
    )
      return false;
    return true;
  };
  /**
   * Checked or not. Web GUI draws the state as a class of the control
   * (lsCheckBox--checked, lsRadioButton--unchecked, ...--checked--disabled);
   * the hidden input inside keeps the state the server drew, so a radio
   * clicked away from still has its input checked: the class wins. A list
   * checkbox shows an image (urCImgOn / urCImgOff).
   */
  const checkedOf = (el: Element) => {
    const cls =
      typeof (el as HTMLElement).className === "string"
        ? (el as HTMLElement).className
        : "";
    if (/--(unchecked|unselected)\b/.test(cls)) return false;
    if (/--(checked|selected)\b|Sel\b/.test(cls)) return true;
    if (el.querySelector(".urCImgOn,.lsCBImgSel")) return true;
    if (el.querySelector(".urCImgOff")) return false;
    const aria = el.getAttribute("aria-checked");
    if (aria) return aria === "true";
    const inp = el.querySelector("input");
    return !!inp && (inp as HTMLInputElement).checked;
  };
  /** A checkbox or radio button that cannot be changed (greyed): Web GUI says so in its class. */
  const selectorLocked = (el: Element) =>
    /--disabled\b|--readonly\b/.test(
      typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "",
    ) || el.getAttribute("aria-disabled") === "true";
  /**
   * An input that cannot be changed. Web GUI marks it on the field's frame
   * (lsField--readonly, lsField--disabled). A dropdown is an <input readonly>
   * by construction (the value is picked, never typed), so for a dropdown the
   * input's own readOnly says nothing.
   */
  const fieldLocked = (el: Element) => {
    const i = el as HTMLInputElement;
    const frameCls = el.closest(".lsField")?.className ?? "";
    if (/lsField--(readonly|disabled)\b/.test(typeof frameCls === "string" ? frameCls : "")) return true;
    if (i.disabled || el.getAttribute("aria-readonly") === "true" || el.getAttribute("aria-disabled") === "true") return true;
    if (/--readonly|--disabled/.test(el.parentElement?.className ?? "")) return true;
    const list =
      el.getAttribute("ct") === "CB" ||
      /lsField--list\b/.test(typeof frameCls === "string" ? frameCls : "") ||
      /Type:'GuiComboBox'/.test(el.getAttribute("data-ls") ?? "");
    return !list && i.readOnly === true;
  };
  const scrollInfo = (domId: string) => {
    // The scrollbar names its control's DOM id in key 6 (tree#105 written tree\x23105).
    const sb = Array.from(document.querySelectorAll("[ct='SCB']")).find(
      (e) =>
        prop(e.getAttribute("data-ls") ?? "", 6) === domId &&
        !/5:'HORIZONTAL'/.test(e.getAttribute("data-ls") ?? ""),
    );
    const ls = sb?.getAttribute("data-ls") ?? "";
    // Key 0 is the first row shown, counted from 1.
    const pos = Number(/[{,]0:(\d+)/.exec(ls)?.[1] ?? NaN);
    return {
      total: Number(/[{,]10:(\d+)/.exec(ls)?.[1] ?? NaN),
      visible: Number(/[{,]3:(\d+)/.exec(ls)?.[1] ?? NaN),
      first: Number.isNaN(pos) ? 0 : Math.max(0, pos - 1),
    };
  };

  // Labels name their field's DOM id in key 1. So does the text SAP writes to the right of a field, the
  // description of its value ("Germany Frankfurt" after sales organization 1000): that one is not the
  // field's name, it goes after the value. And a label can point at a button that stands before its
  // field (XD03, Customer): the field is then named by the label of its own SAP name (lblRF02D-KUNNR).
  const labelFor = new Map<string, string>();
  const labelEl = new Map<string, Element>();
  const describedBy = new Map<string, string>();
  const labelNamed = new Map<string, string>();
  for (const el of Array.from(
    document.querySelectorAll("[data-ls*=\"Type:'GuiLabel'\"]"),
  )) {
    const forId = /^\{1:'((?:[^'\\]|\\.)*)'/.exec(
      el.getAttribute("data-ls") ?? "",
    )?.[1];
    const t = norm((el as HTMLElement).innerText);
    if (!t || !visible(el)) continue;
    const own = info(el).sid;
    if (/\/lbl[^/]+$/.test(own) && !labelNamed.has(own)) labelNamed.set(own, t);
    if (!forId) continue;
    const k = unesc(forId);
    const field = document.getElementById(k);
    const after = !!field && visible(field) && el.getBoundingClientRect().left >= field.getBoundingClientRect().right - 1;
    if (after) {
      describedBy.set(k, describedBy.has(k) ? `${describedBy.get(k)} ${t}` : t);
      continue;
    }
    labelFor.set(k, labelFor.has(k) ? `${labelFor.get(k)} ${t}` : t);
    if (!labelEl.has(k)) labelEl.set(k, el);
  }
  /** The name of a field: its label, else the label of its SAP name, else "". */
  const nameOf = (el: Element, sid: string) => labelFor.get(el.id) ?? labelNamed.get(sid.replace(/\/[a-z]+([^/]*)$/, "/lbl$1")) ?? "";
  const usedLabels = new Set<string>();

  // SAP's message popup (a message shown in a window of its own): an icon label says its type, and the
  // text is cut over the labels MESSTXT1, MESSTXT2... The view gives it as the status bar's message is
  // given: the type, then the whole text on one line. Type A is a termination: its only button ends the transaction.
  const popupMessage = new Map<number, { first: string; text: string; type: string }>();
  for (const el of Array.from(document.querySelectorAll("[data-ls*=\"Type:'GuiLabel'\"]"))) {
    const i = info(el);
    if (!i.modal || !visible(el)) continue;
    const icon = /\/s_m_(crit|erro|warn|info)\.[a-z]+$/.exec(el.querySelector("img[src]")?.getAttribute("src") ?? "")?.[1];
    const part = /\/usr\/txtMESSTXT\d+$/.test(i.sid) ? norm((el as HTMLElement).innerText) || prop(i.ls, 3) : "";
    if (!icon && !part) continue;
    const m = popupMessage.get(i.modal) ?? { first: "", text: "", type: "" };
    if (icon) m.type = ({ crit: "A", erro: "E", warn: "W", info: "I" } as Record<string, string>)[icon] ?? "";
    if (part) {
      if (!m.first) m.first = i.sid;
      m.text = m.text ? `${m.text} ${part}` : part;
    }
    popupMessage.set(i.modal, m);
  }

  // After an error or a warning SAP puts the cursor on the field the message is about: the view says which.
  const sbarKind = prop(document.getElementById("wnd[0]/sbar_msg")?.getAttribute("data-ls") ?? "", 1).toUpperCase();
  const cursorTold = sbarKind === "ERROR" || sbarKind === "WARNING";
  const lines = new Map<number, string[]>();
  const titles = new Map<number, string>();
  const out = (modal: number, line: string) => {
    if (!lines.has(modal)) lines.set(modal, []);
    lines.get(modal)!.push(line);
  };
  /** Containers whose content is read as a whole (trees, grids, value-help lists). */
  const handled: Element[] = [];
  const inHandled = (el: Element) =>
    handled.some((h) => h !== el && h.contains(el));

  // Popups that have the x of a window in their title.
  const closable = new Set<number>();
  // Window titles.
  titles.set(
    0,
    prop(
      document.getElementById("cuaheader")?.getAttribute("data-ls") ?? "",
      1,
    ) || norm(document.title),
  );
  // A popup window is ct="PW" on ECC and ct="PW_standards" on S/4HANA 2025 (its title in the new header):
  // any ct that starts with PW, and any element that says it is a modal window.
  for (const el of Array.from(
    document.querySelectorAll("[ct^='PW'][data-ls],[data-ls*=\"Type:'GuiModalWindow'\"]"),
  )) {
    const i = info(el);
    if (!i.modal || !visible(el)) continue;
    const t = norm(
      (
        (document.getElementById(`${el.id}-ttltxt`) ??
          document.getElementById(`${el.id}-header-title-txt`) ??
          el.querySelector(".urPWTitleText,[role='heading']")) as HTMLElement | null
      )?.innerText,
    );
    if (t && !titles.has(i.modal)) titles.set(i.modal, t);
    const x = document.getElementById(`${el.id}-close`);
    if (x && visible(x)) closable.add(i.modal);
    // A popup with nothing the view lists (a text only) is still a window that blocks the screen.
    if (!lines.has(i.modal)) lines.set(i.modal, []);
  }

  /** A row selector cell (subct SC) shows a selected row with a "Sel" icon class, an unselected one with "UnSel". */
  const selectorOn = (sc: Element) => {
    const cls = `${sc.className} ${sc.firstElementChild?.className ?? ""}`;
    return !/UnSel/.test(cls) && /urSTRowSel|LbSelIcon|Sel2BgColor/.test(cls);
  };
  /**
   * Rows of a Lightspeed smart table (grid, tree, value-help list), merged
   * across its left/right segments, with the state of each row's selector
   * cell. Row 0 is the column header when the table has one; a tree without
   * header (SAP Easy Access) has its first node there.
   */
  const matrix = (root: Element) => {
    const box = root.getBoundingClientRect();
    const rows = new Map<
      number,
      { cells: Map<number, Element>; tr: Element; selector?: Element }
    >();
    const headed = !!root.querySelector("th[lsmatrixrowindex='0'],th[lsmatrixcolindex]");
    for (const td of Array.from(
      root.querySelectorAll("td[lsmatrixrowindex][lsmatrixcolindex]"),
    )) {
      const r = Number(td.getAttribute("lsmatrixrowindex"));
      if (r === 0 && headed) continue;
      const tr = td.closest("tr")!;
      if (!rows.has(r)) rows.set(r, { cells: new Map(), tr });
      if (td.getAttribute("subct") === "SC") {
        rows.get(r)!.selector = td;
        continue;
      }
      const c = Number(td.getAttribute("lsmatrixcolindex"));
      rows.get(r)!.cells.set(c, td);
    }
    const heads = new Map<number, Element>();
    for (const th of Array.from(root.querySelectorAll("th[lsmatrixcolindex]")))
      heads.set(Number(th.getAttribute("lsmatrixcolindex")), th);
    return {
      box,
      rows: [...rows.entries()].filter(([, r]) => r.cells.size > 0).sort((a, b) => a[0] - b[0]),
      heads,
      /** The table has a row selector column: rows can be selected. */
      selectable: !!root.querySelector("td[subct='SC']"),
    };
  };
  const cellText = (td: Element) => {
    // A checkbox or radio button in a cell: its state, from its class (its hidden input says "on" whatever the state).
    const sel = td.querySelector("[ct^='C_'],[ct^='R_'],.lsCheckBox,[class*='lsRadioButton'],[class*='lsCheckBox']");
    if (sel) return checkedOf(sel) ? "X" : "";
    const inp = td.querySelector("input,textarea") as HTMLInputElement | null;
    // A password is never written out.
    if (inp) return inp.type === "password" ? (inp.value ? "***" : "") : norm(inp.value);
    const cb = td.querySelector("[data-ls*=\"Type:'GuiCheckBox'\"],[ct^='C']");
    if (cb && /lsCheckBox/.test((cb as HTMLElement).className))
      return checkedOf(cb) ? "X" : "";
    const t = norm((td as HTMLElement).innerText);
    if (t) return t;
    // An icon (status light, PO history): its tooltip.
    const icon = td.querySelector("img[title],img[alt],[title]");
    return (
      norm(td.getAttribute("title")) ||
      norm(icon?.getAttribute("title")) ||
      norm(icon?.getAttribute("alt"))
    );
  };
  const headTitle = (th: Element | undefined) =>
    th
      ? norm((th as HTMLElement).innerText) ||
        norm(th.getAttribute("title")) ||
        prop(th.getAttribute("data-ls") ?? "", 7)
      : "";

  for (const el of Array.from(document.querySelectorAll("[data-ls]"))) {
    const { ls, sid, type: ownType, modal } = info(el);
    if (!sid || !ownType) continue;
    // The value help dialog of S/4HANA 2025 types its OK and Cancel buttons as the dialog (GuiSearchHelp, SubType toolbar).
    const type = ownType === "GuiSearchHelp" && el.getAttribute("ct") === "B" ? "GuiButton" : ownType;
    const button = type === "GuiButton" || type === "GuiToggleButton" || type === "GuiDropDownButton";
    // A grid is read whole, except its own toolbar: those buttons are controls of their own.
    if (inHandled(el) && !(button && /\/tbar\/[^/]+$/.test(sid))) continue;
    if (sid.includes("sysInfoArea")) continue;
    // A toolbar too narrow for its buttons moves the last ones behind its ">>" button (lsToolbar--item-hidden).
    const overflow = button && !visible(el) && !!el.closest(".lsToolbar--item-hidden") && !!el.closest("[ct='T']") && visible(el.closest("[ct='T']")!);
    if (!visible(el) && !overflow) continue;
    const h = el as HTMLElement & { value?: string };
    const tip = norm(el.getAttribute("title"));
    switch (type) {
      case "GuiCTextField":
      case "GuiTextField":
      case "GuiPasswordField": {
        // S/4HANA 2025 draws a table cell as a text box that is not an input (<span role="textbox">) until it
        // is clicked: it is the field all the same, with its value as its text.
        const drawnAsText = el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";
        if (drawnAsText && el.getAttribute("role") !== "textbox") break;
        let colTitle = "";
        if (/\/tbl[^/]+\/[^/]+\[\d+,\d+\]$/.test(sid)) {
          // A table-control cell (the input inside the cell).
          const tbl = el.closest("[data-ls*=\"Type:'GuiTableControl'\"]");
          if (tbl && !inView(el, tbl.getBoundingClientRect())) break;
          // S/4HANA 2025 gives a cell no tooltip: it is named by its column's title.
          if (tbl && !tip) {
            const c = el.closest("td[lsmatrixcolindex]")?.getAttribute("lsmatrixcolindex");
            const th = c ? Array.from(tbl.querySelectorAll("th[lsmatrixcolindex]")).find((x) => x.getAttribute("lsmatrixcolindex") === c) : undefined;
            colTitle = headTitle(th);
          }
        }
        const lab = nameOf(el, sid) || (tip ? "" : colTitle);
        if (lab) usedLabels.add(el.id);
        const described = describedBy.get(el.id);
        const ro = fieldLocked(el);
        // A password is never written out, whatever type SAP gives the field.
        const secret =
          type === "GuiPasswordField" ||
          (h as HTMLInputElement).type === "password";
        const val = secret ? (h.value ? "***" : "") : norm(drawnAsText ? h.innerText : (h.value ?? ""));
        // A required entry: Web GUI marks the field or its label (aria-required, a --required class); SAP GUI draws a "?" in it.
        const lbl = labelEl.get(el.id);
        const required =
          !ro &&
          (el.getAttribute("aria-required") === "true" ||
            /--required\b|Required\b|urEdf2Req/.test(`${el.closest(".lsField")?.className ?? ""} ${el.className} ${lbl?.className ?? ""} ${lbl?.firstElementChild?.className ?? ""}`));
        out(
          modal,
          `${sid}  field  ${lab || tip || norm(el.getAttribute("aria-label")) || norm(el.getAttribute("placeholder"))} = "${val}"${described && !secret ? ` ${described}` : ""}  (${ro ? "read-only" : "edit"})${required ? "  required" : ""}${cursorTold && document.activeElement === el ? "  (cursor here)" : ""}`,
        );
        break;
      }
      case "GuiLabel": {
        const forId = unesc(/^\{1:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "");
        const t = norm(h.innerText) || prop(ls, 3);
        // A label whose field is on screen is shown on the field's line.
        const target = forId ? document.getElementById(forId) : null;
        if (
          target &&
          visible(target) &&
          info(target).type &&
          info(target).type !== "GuiLabel"
        )
          break;
        const pm = popupMessage.get(modal);
        if (pm && /\/usr\/txtMESSTXT\d+$/.test(sid)) {
          if (sid === pm.first)
            out(modal, `${sid}  label  ${pm.type ? `${pm.type}: ` : ""}${pm.text}${pm.type === "A" ? "  (termination message: SAP ends the transaction when it is confirmed, and unsaved input is lost)" : ""}`);
          break;
        }
        if (t) out(modal, `${sid}  label  ${t}`);
        // A label that is an icon (the operator of a selection criterion, a status light): its tooltip says what it shows.
        else if (tip || prop(ls, 0)) out(modal, `${sid}  label  icon "${tip || prop(ls, 0)}"`);
        break;
      }
      case "GuiCheckBox":
      case "GuiRadioButton": {
        if (el.tagName === "INPUT") break;
        const tbl = el.closest("[data-ls*=\"Type:'GuiTableControl'\"]");
        if (tbl && !inView(el, tbl.getBoundingClientRect())) break;
        const t = prop(ls, 4) || norm(h.innerText) || prop(ls, 5) || tip;
        out(
          modal,
          `${sid}  ${type === "GuiCheckBox" ? "checkbox" : "radio"}  [${checkedOf(el) ? "x" : " "}] ${t}${selectorLocked(el) ? "  (read-only)" : ""}`,
        );
        break;
      }
      case "GuiComboBox": {
        if (el.tagName !== "INPUT") break;
        // A dropdown cell of a table control scrolled out sideways is not on the screen.
        const tblC = el.closest("[data-ls*=\"Type:'GuiTableControl'\"]");
        if (tblC && !inView(el, tblC.getBoundingClientRect())) break;
        const lab = nameOf(el, sid) || tip;
        // S/4HANA 2025 keeps the field name in key 3 (VBAK-LIFSKSAPMV45A), not the selected key.
        const k3 = prop(ls, 3);
        // S/4HANA 2025: key 3 names the field (VBAK-LIFSKSAPMV45A), key 4 holds
        // the selected key, the input shows the text, and the list box is the
        // element named by aria-controls.
        const s4 = /^[A-Z0-9_/]+-[A-Z0-9_]+/.test(k3);
        const lb = document.getElementById(
          s4 ? (h.getAttribute("aria-controls") ?? "") : prop(ls, 2),
        );
        const ro = fieldLocked(el);
        const opts: string[] = [];
        // The input shows the entry chosen now; lsdata holds what the server drew last.
        const shown = norm(h.value ?? "");
        let key = s4 ? norm(prop(ls, 4)) : k3;
        let text = s4 ? shown : shown || prop(ls, 4);
        for (const it of Array.from(
          lb?.querySelectorAll("[ct='LIB_I'],[data-itemkey]") ?? [],
        )) {
          const ils = it.getAttribute("data-ls") ?? "";
          const k =
            it.getAttribute("data-itemkey") ?? (prop(ils, 3) || prop(ils, 1));
          const v =
            prop(ils, 4) ||
            norm(it.getAttribute("data-itemvalue2")) ||
            norm((it as HTMLElement).innerText);
          // Chosen in the page and not sent yet: the key of the entry the input shows.
          if (shown && v === shown && k !== key && shown !== prop(ls, 4)) {
            key = k;
            text = v;
          }
          // A read-only dropdown (display transactions) cannot change: its entries add only tokens.
          if (!ro && (k || v)) opts.push(`${k}:${v}`);
        }
        out(
          modal,
          `${sid}  dropdown  ${lab} = "${key}" ${text}  (${ro ? "read-only" : "edit"})${opts.length ? `  ${opts.length} options: ${opts.slice(0, 30).join(", ")}${opts.length > 30 ? ", ..." : ""}` : ""}`,
        );
        break;
      }
      case "GuiButton":
      case "GuiToggleButton":
      case "GuiDropDownButton": {
        // The Menu and System buttons of the toolbar have no scripting id (the menu bar line stands for them).
        if (sid.endsWith("/") || /\/\[\d+\]$/.test(sid)) break;
        const t = norm(h.innerText) || prop(ls, 4) || prop(ls, 0);
        if (!t && !tip) break;
        // "Back" with tooltip "Back (F3)": one name, with its key.
        const name = tip && (!t || tip.startsWith(t)) ? tip : t;
        // A button SAP shows greyed out takes no click (the role details of a partner that has no role to show).
        const grey = /--disabled\b|Dsbl\b/.test(typeof h.className === "string" ? h.className : "") || el.getAttribute("aria-disabled") === "true";
        out(
          modal,
          `${sid}  button  ${name}${t && tip && !tip.startsWith(t) ? `  (${tip})` : ""}${overflow ? '  (behind ">>")' : ""}${grey ? "  (greyed out: SAP does not offer it now)" : ""}`,
        );
        break;
      }
      case "GuiTab": {
        // A tab that shows an icon only is named by its tooltip.
        const t = norm(prop(ls, 2)) || norm(h.innerText) || tip || norm(el.querySelector("img[title],[title]")?.getAttribute("title"));
        const sel =
          /Sel\b|ItemSel|--selected/.test(h.className) ||
          el.getAttribute("aria-selected") === "true" ||
          // S/4HANA 2025: the selection sits on the tab's inner title element.
          !!el.querySelector("[aria-selected='true']");
        out(modal, `${sid}  tab  ${t}${sel ? " (selected)" : ""}`);
        break;
      }
      case "GuiBox": {
        const t = prop(ls, 1);
        if (t) out(modal, `${sid}  group  ${t}`);
        break;
      }
      case "GuiOKCodeField":
        out(modal, `${sid}  command-field`);
        break;
      case "GuiTextEdit": {
        // The lines of the text, with "\n" between them (a backslash and an n: the view has one line per control).
        const raw = (h as HTMLTextAreaElement).value ?? h.innerText ?? "";
        const v =
          (h as HTMLInputElement).type === "password"
            ? "***"
            : raw
                .split(/\r\n?|\n/)
                .map((x) => norm(x))
                .join("\\n")
                .replace(/(\\n)+$/, "")
                .slice(0, 2000);
        out(modal, `${sid}  text-editor  "${v}"`);
        break;
      }
      case "GuiHtmlViewer":
        out(modal, `${sid}  html-viewer`);
        break;
      case "GuiTableControl": {
        const cols =
          /ColumnIds:\[([^\]]*)\]/
            .exec(ls)?.[1]
            ?.split(",")
            .map((x) => unesc(x.replace(/^'|'$/g, ""))) ?? [];
        const byName = new Map<string, string>();
        for (const th of Array.from(
          el.querySelectorAll("th[data-ls*='GuiTableColumn']"),
        )) {
          const name = /\/col([^/]+)$/.exec(info(th).sid)?.[1];
          if (name)
            byName.set(
              name,
              headTitle(th) || prop(th.getAttribute("data-ls") ?? "", 7),
            );
        }
        const s = scrollInfo(el.id);
        // The table's title sits in a title row above the column headers.
        const capEl = el.querySelector(".urST3Tit [ct='CP']");
        const cap = capEl
          ? prop(capEl.getAttribute("data-ls") ?? "", 1) ||
            norm((capEl as HTMLElement).innerText)
          : "";
        // Row selectors (the column of buttons at the left): which rows on screen are selected.
        const tbox = el.getBoundingClientRect();
        const selectors = Array.from(el.querySelectorAll("td[subct='SC'][lsmatrixrowindex]")).filter(
          (td) => Number(td.getAttribute("lsmatrixrowindex")) > 0 && inView(td, tbox),
        );
        const picked = selectors
          .filter(selectorOn)
          .map((td) => Number(td.getAttribute("lsmatrixrowindex")) - 1)
          .sort((a, b) => a - b);
        const how = /[{,]10:'(MULTI|SINGLE)'/.exec(ls)?.[1];
        const selection = selectors.length
          ? `; rows can be selected${how === "SINGLE" ? " (one at a time)" : ""}${picked.length ? `; selected rows ${picked.join(",")}` : ""}`
          : "";
        out(
          modal,
          `${sid}  table  rows ${Number.isNaN(s.total) ? "?" : s.total} (visible ${Number.isNaN(s.visible) ? "?" : s.visible}${s.first ? `, first ${s.first}` : ""})${cap ? ` "${cap}"` : ""}${selection}; columns: ${cols.map((c) => byName.get(c) ?? "").join(" | ")}`,
        );
        // Cells come after, as their own controls (inputs, checkboxes; display cells here).
        const box = el.getBoundingClientRect();
        for (const td of Array.from(
          el.querySelectorAll("td[data-ls*=\"Type:'SAPTABLECSCELL'\"]"),
        )) {
          const ci = info(td);
          // A cell that holds a control of its own (an input, a checkbox, the text box of S/4HANA 2025) is listed as that control.
          if (
            td.querySelector("input,[data-ls*='GuiCheckBox'],[role='textbox'][data-ls*='SID:']") ||
            !inView(td, box)
          )
            continue;
          const t = norm((td as HTMLElement).innerText);
          if (t)
            out(
              ci.modal,
              `${ci.sid}  field  ${byName.get(ci.sid.replace(/.*\/[a-z]+([^/[]+)\[\d+,\d+\]$/, "$1")) ?? ""} = "${t}"  (read-only)`,
            );
        }
        break;
      }
      case "GuiGridView":
      case "GuiValueHelpResult":
      case "GuiSearchHelpResult": {
        handled.push(el);
        const colIds = (/ColumnI[dD]s:\[([^\]]*)\]/.exec(ls)?.[1] ?? "")
          .split(",")
          .filter(Boolean)
          .map((x) => unesc(x.replace(/^'|'$/g, "")));
        const m = matrix(el);
        const inRows = [
          ...new Set(m.rows.flatMap(([, r]) => [...r.cells.keys()])),
        ].sort((a, b) => a - b);
        // A grid without rows still has its columns: its header names them.
        const colIdx = inRows.length ? inRows : [...m.heads.keys()].sort((a, b) => a - b);
        const names = colIdx.map((c, i) => {
          const th = m.heads.get(c);
          const name =
            /\/col([^/]+)$/.exec(th ? info(th).sid : "")?.[1] ??
            colIds[i] ??
            String(c);
          return `${name}=${headTitle(th)}`;
        });
        const s = scrollInfo(el.id);
        const shown = m.rows.filter(([, r]) => inView(r.tr, m.box));
        const total = Number.isNaN(s.total) ? m.rows.length : s.total;
        const idOfCol = (c: number, i: number) => /\/col([^/]+)$/.exec(m.heads.get(c) ? info(m.heads.get(c)!).sid : "")?.[1] ?? colIds[i] ?? String(c);
        // A title above the column headers (the two lists of "Change Layout").
        const capEl = el.querySelector(".urST3Tit [ct='CP']");
        const cap = capEl ? prop(capEl.getAttribute("data-ls") ?? "", 1) || norm((capEl as HTMLElement).innerText) : "";
        // What the column headers show besides their title: selected (for the toolbar's sort, total, filter), and
        // the icon of a sort, a total or a filter. The icon's file name says which: head + a|d|o (sorted
        // ascending, descending, not) + t|o (totalled or not) + f|o (filtered or not), measured on ECC.
        const picked: string[] = [];
        const marks: string[] = [];
        colIdx.forEach((c, i) => {
          const th = m.heads.get(c);
          if (!th) return;
          const id = idOfCol(c, i);
          if (/\burST3HSel\b/.test(typeof th.className === "string" ? th.className : "")) picked.push(id);
          const icon = /\/head([ado])([a-z])([a-z])\.[a-z]+$/.exec(th.querySelector("img[id$='-HCICO']")?.getAttribute("src") ?? "");
          if (!icon) return;
          const what = [icon[1] === "a" ? "sorted ascending" : icon[1] === "d" ? "sorted descending" : "", icon[2] === "t" ? "totalled" : "", icon[3] === "f" ? "filtered" : ""].filter(Boolean);
          if (what.length) marks.push(`${id} ${what.join(" and ")}`);
        });
        // Cells that take input (an editable ALV): by column, and in which of the rows shown.
        const open = (td: Element | undefined) => {
          if (!td) return false;
          // A checkbox or a radio button in a cell is clicked, not typed into.
          if (td.querySelector("[ct^='C_'],[ct^='R_'],[class*='lsCheckBox'],[class*='lsRadioButton'],input[type=checkbox],input[type=radio]")) return false;
          if (/^\{2:'EDIT'/.test(td.getAttribute("data-ls") ?? "")) return true;
          const inp = td.querySelector("input:not([type=hidden]),textarea") as HTMLInputElement | null;
          return !!inp && !inp.readOnly && !inp.disabled && !/lsField--(readonly|disabled)\b/.test(inp.closest(".lsField")?.className ?? "");
        };
        const rowsShown = shown.slice(0, limits.grid);
        // A row of totals or subtotals is no row of data: SAP marks the summed cell (MARKTOTALS), and draws the
        // whole row in the totals colour. The colour in some cells only is a coloured column (SE16N draws
        // every amount and quantity column in it), so it says nothing about the row.
        const totalColour = (td: Element) => /[{,]\d+:'COL_TOTAL/.test(td.getAttribute("data-ls") ?? "") || /\burColorTotal/.test(typeof td.className === "string" ? td.className : "");
        const totals = (row: { cells: Map<number, Element> }) => {
          const cells = colIdx.map((c) => row.cells.get(c)).filter((td): td is Element => !!td);
          return cells.some((td) => /[{,]\d+:'MARK\w*TOTALS'/.test(td.getAttribute("data-ls") ?? "")) || (cells.length > 1 && cells.every(totalColour));
        };
        const dataRows = rowsShown.filter(([, row]) => !totals(row)).length;
        const editable: string[] = [];
        colIdx.forEach((c, i) => {
          const rows = rowsShown.filter(([, row]) => open(row.cells.get(c))).map(([r]) => r - 1);
          if (!rows.length) return;
          editable.push(rows.length === dataRows ? idOfCol(c, i) : `${idOfCol(c, i)} (rows ${rows.slice(0, 8).join(",")}${rows.length > 8 ? ",..." : ""})`);
        });
        const state = `${picked.length ? `; selected columns: ${picked.join(", ")}` : ""}${marks.length ? `; ${marks.join(", ")}` : ""}${
          editable.length ? `; cells that take input ("set" with "row" and "col"): ${editable.join(", ")}` : ""
        }`;
        out(
          modal,
          `${sid}  grid  ${total} rows${cap ? ` "${cap}"` : ""}${total === 0 ? " (the list is empty: SAP found no data for it)" : ""}${m.selectable ? "; rows can be selected" : ""}${state}; columns: ${names.join(" | ")}`,
        );
        for (const [r, row] of rowsShown)
          out(
            modal,
            `  row ${r - 1}${row.selector && selectorOn(row.selector) ? " (selected)" : ""}${totals(row) ? " (total)" : ""}: ${colIdx.map((c) => (row.cells.get(c) ? cellText(row.cells.get(c)!) : "")).join(" | ")}`,
          );
        const first = shown[0]?.[0] ?? 1;
        const rest = total - Math.min(shown.length, limits.grid);
        if (rest > 0)
          out(
            modal,
            shown.length
              ? `  ... ${rest} more rows (shown: ${first - 1} to ${first - 2 + Math.min(shown.length, limits.grid)}; scroll for the others)`
              : `  ... ${rest} rows, none drawn yet`,
          );
        break;
      }
      case "GuiTree": {
        handled.push(el);
        const m = matrix(el);
        // Node keys in display order (rows without a drag-and-drop key take theirs from here).
        const keyOf = new Map<number, string>();
        const idx = /nodeindexes:\[(.*?)\]\]/.exec(ls)?.[1] ?? "";
        let k = 0;
        for (const x of execAll(idx, /\['((?:[^'\\]|\\.)*)',/g))
          keyOf.set(k++, norm(unesc(x[1] ?? "")));
        const heads = [...m.heads.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, th]) => headTitle(th))
          .filter(Boolean);
        const nodes: string[] = [];
        // Icons of a node that are links (documentation and activity in the IMG): its items, by name.
        const itemsOf: { name: string; title: string }[][] = [];
        // A tree with columns (MMBE): one value per column, empty ones kept, so each value stays under its title.
        const columns = heads.length > 1 ? Math.max(...m.heads.keys()) : -1;
        for (const [, row] of m.rows) {
          if (!inView(row.tr, m.box)) continue;
          const key =
            norm((row.tr.getAttribute("dddata") ?? "").split("#")[0]) ||
            (keyOf.get(Number(row.tr.getAttribute("iidx"))) ?? "");
          const cells = [...row.cells.entries()].sort((a, b) => a[0] - b[0]);
          const hier =
            cells.find(([, td]) => td.getAttribute("subct") === "HIC")?.[1] ??
            cells[0]?.[1];
          const depth = Number(hier?.getAttribute("lv") ?? 0);
          const st = prop(hier?.getAttribute("data-ls") ?? "", 5);
          const state =
            st === "EXPANDED" ? "[-] " : st === "COLLAPSED" ? "[+] " : "";
          let text: string;
          if (columns >= 0) {
            const vals: string[] = [];
            for (let c = 0; c <= columns; c++) vals.push(row.cells.get(c) ? norm((row.cells.get(c) as HTMLElement).innerText) : "");
            while (vals.length > 1 && !vals[vals.length - 1]) vals.pop();
            text = vals.join(" | ");
          } else
            text = [
              ...new Set(
                cells
                  .map(([, td]) => norm((td as HTMLElement).innerText))
                  .filter(Boolean),
              ),
            ].join(" | ");
          // Web GUI keeps empty placeholder rows below the last node: not nodes.
          if (!key && !text.replace(/[ |]/g, "")) continue;
          // The node that was clicked last: Web GUI marks its hierarchy cell (urST4Sel2).
          const picked = /\burST\d+Sel\d*\b/.test(typeof hier?.className === "string" ? hier.className : "");
          itemsOf.push(
            Array.from(row.tr.querySelectorAll("a[ct='LN']"))
              // An icon without a tooltip is a spacer (it keeps the texts aligned): no item.
              .filter((x) => !norm((x as HTMLElement).innerText) && /#[^#]+#i$/.test(x.id) && norm(x.getAttribute("title")))
              .map((x) => ({ name: x.id.split("#").slice(-2)[0] ?? "", title: norm(x.getAttribute("title")) })),
          );
          nodes.push(`  ${"  ".repeat(depth)}${state}${text}${picked ? " (selected)" : ""}  {node ${key}}`);
        }
        // An item that says the same on every node is explained once, in the tree's line; the nodes name their items.
        const titlesOf = new Map<string, Set<string>>();
        for (const items of itemsOf)
          for (const it of items) {
            if (!titlesOf.has(it.name)) titlesOf.set(it.name, new Set());
            titlesOf.get(it.name)!.add(it.title);
          }
        const common = [...titlesOf.entries()].filter(([, t]) => t.size === 1);
        itemsOf.forEach((items, i) => {
          if (!items.length) return;
          const said = items.map((it) => (titlesOf.get(it.name)!.size === 1 ? it.name : `${it.name}=${it.title}`)).join(", ");
          nodes[i] = (nodes[i] ?? "").replace(/ {2}\{node ([^}]*)\}$/, ` [items ${said}]  {node $1}`);
        });
        const itemsNote = titlesOf.size ? `; node items${common.length ? ` ${common.map(([n, t]) => `${n}=${[...t][0]}`).join(", ")}` : ""} ("tree" with "node" and "col":"<item>" clicks one)` : "";
        out(
          modal,
          `${sid}  tree  ${nodes.length} nodes shown${(() => {
            // A tree longer than its frame: the scrollbar counts its lines.
            const sc = scrollInfo(el.id);
            return !Number.isNaN(sc.total) && sc.total > nodes.length
              ? ` of ${sc.total} (first ${sc.first}; scroll for the others)`
              : "";
          })()}${itemsNote}${heads.length ? `; columns: ${heads.join(" | ")}` : ""}`,
        );
        for (const n of nodes.slice(0, limits.tree)) out(modal, n);
        break;
      }
      case "ABAPLIST": {
        // A classic list: its cells follow, named by column and row like SAP GUI's (lbl[col,row]).
        const sc = scrollInfo(el.id);
        // The lines above the part that scrolls (titles, column heads) stay: the screen shows them and `visible` more.
        let lastLine = -1;
        for (const c of Array.from(el.querySelectorAll("[data-ls*='SID:']"))) {
          const m = /\/usr\/[a-z]+\[\d+,(\d+)\]/.exec(c.getAttribute("data-ls") ?? "");
          if (m) lastLine = Math.max(lastLine, Number(m[1]));
        }
        const fixed = Number.isNaN(sc.visible) ? 0 : Math.max(0, lastLine + 1 - sc.visible);
        out(
          modal,
          `${sid}  list  ${Number.isNaN(sc.total) ? "all rows shown" : `${sc.total} rows (visible ${Number.isNaN(sc.visible) ? "?" : sc.visible}${sc.first ? `, first ${sc.first}` : ""}${fixed ? `, below ${fixed} title rows` : ""}; scroll for the others)`}`,
        );
        break;
      }
      case "ABAPLISTTEXT": {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          const i = el as HTMLInputElement;
          const val = i.type === "password" ? (i.value ? "***" : "") : norm(i.value);
          out(
            modal,
            `${sid}  field  ${tip} = "${val}"  (${i.readOnly || i.disabled ? "read-only" : "edit"})`,
          );
          break;
        }
        const t = norm(h.innerText);
        if (t) out(modal, `${sid}  label  ${t}`);
        break;
      }
      case "ABAPLISTIMAGE": {
        // An icon in a list (a status light, a ledger): its tooltip says what it shows.
        const t = tip || norm(el.querySelector("img")?.getAttribute("alt")) || norm(el.querySelector("img")?.getAttribute("title"));
        if (t) out(modal, `${sid}  label  icon "${t}"`);
        break;
      }
      case "ABAPLISTCHECKBOX": {
        out(modal, `${sid}  checkbox  [${checkedOf(el) ? "x" : " "}] ${tip}`);
        break;
      }
      case "GuiSearchHelpPage": {
        // The restrictions of a value help: a panel that opens and closes with the arrow left of its title.
        const t = prop(ls, 8);
        const stack = el.closest("table[ct='PST']");
        const toggle = stack ? document.getElementById(`${stack.id}-tgl`) : null;
        const closed = !!toggle && /TglIconCol\b/.test(toggle.className);
        const chosen = !!stack && prop(stack.getAttribute("data-ls") ?? "", 8) === el.id;
        // The other search helps of the field are behind the button at the right of the title: said once, with the way to them.
        const others = stack ? stack.querySelectorAll("div[ct='P']").length : 0;
        if (t)
          out(
            modal,
            `${sid}  tab  ${t}${closed ? '  (closed: "select" opens it and shows its fields)' : chosen ? " (selected)" : ""}${others > 1 ? `  (1 of ${others} search helps: "combo" on this id lists them, with "key" chooses one)` : ""}`,
          );
        break;
      }
      case "GuiSearchHelpPageItem": {
        // A restriction field of a value help. Its label names it by DOM id (attribute f), with no scripting id.
        if (el.tagName !== "INPUT") break;
        const lab = Array.from(document.querySelectorAll("label[ct='L'][f]")).find((l) => l.getAttribute("f") === el.id);
        const ro = fieldLocked(el);
        out(modal, `${sid}  field  ${norm((lab as HTMLElement | undefined)?.innerText) || tip} = "${norm(h.value ?? "")}"  (${ro ? "read-only" : "edit"})`);
        break;
      }
      case "GuiSearchHelpHeaderItem": {
        // A filter of the value help dialog of S/4HANA 2025: a token field, named in its lsdata (LabelledBy).
        // Its frame carries the same id: the innermost element is the field.
        if (el.querySelector("[data-ls*=\"Type:'GuiSearchHelpHeaderItem'\"]")) break;
        // While the dialog draws, a filter can be in the page twice: it is listed once.
        if (lines.get(modal)?.some((l) => l.startsWith(`${sid}  `))) break;
        // While it holds a value as a token it has no input: the token is its value.
        const inp = el.querySelector("input") as HTMLInputElement | null;
        const lab = unesc(/LabelledBy:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "") || tip;
        const tokens = Array.from(el.querySelectorAll("[ct='TOKEN']")).map((t) => norm((t as HTMLElement).innerText)).filter(Boolean);
        const val = [...tokens, norm(inp?.value)].filter(Boolean).join(", ");
        out(modal, `${sid}  field  ${lab} = "${val}"  (${fieldLocked(inp ?? el) ? "read-only" : "edit"})`);
        break;
      }
      case "GuiCalendar": {
        // The calendar of a date's value help: the date it holds is in its own field, which can be typed into.
        const date = el.querySelector("input[ct='I']") as HTMLInputElement | null;
        if (!date || !visible(date)) break;
        const format = prop(date.getAttribute("data-ls") ?? date.getAttribute("lsdata") ?? "", 9);
        out(modal, `${sid}  field  Date = "${norm(date.value)}"  (edit)  calendar${format ? ` (${format})` : ""}: "set" the date here, then Continue copies it to the field`);
        break;
      }
      default:
        break;
    }
  }

  // Texts of value-help popups outside their list ("291 Entries found").
  for (const area of Array.from(
    document.querySelectorAll("[ct='SL'][data-ls*=\"Type:'GuiSearchHelp'\"]"),
  )) {
    const { sid, modal } = info(area);
    for (const tv of Array.from(area.querySelectorAll("[ct='TV']"))) {
      const t = norm((tv as HTMLElement).innerText);
      if (t && visible(tv) && !inHandled(tv)) out(modal, `${sid}  label  ${t}`);
    }
  }
  // A popup without a button of its own (the error log of an editable grid, a docked list) closes with the x
  // in its title only: that x is its one button. Popups with buttons are closed by those.
  for (const k of closable) {
    const own = lines.get(k);
    if (own && !own.some((l) => / {2}button {2}/.test(l))) own.push(`wnd[${k}]/close  button  Close  (the x in the title of this window: it has no other button)`);
  }
  // Status bar of the main window, with its message type.
  const msg = document.getElementById("wnd[0]/sbar_msg");
  if (msg) {
    const mls = msg.getAttribute("data-ls") ?? "";
    const text = prop(mls, 0) || norm((msg as HTMLElement).innerText);
    const kind = prop(mls, 1).toUpperCase();
    const mt =
      (
        {
          ERROR: "E",
          WARNING: "W",
          SUCCESS: "S",
          OK: "S",
          INFO: "I",
          INFORMATION: "I",
          ABORT: "A",
          STOP: "A",
        } as Record<string, string>
      )[kind] ?? "";
    if (text && kind !== "LOADING")
      out(0, `wnd[0]/sbar  status  ${mt ? `${mt}: ` : ""}${text}`);
  }
  // Menu bar: Web GUI keeps it as an HTML template behind the Menu button.
  let mbarShown = false;
  for (const x of Array.from(document.querySelectorAll(".lsMnu--root xmp"))) {
    const src = x.textContent ?? "";
    if (
      !src.includes("SID:'wnd[0]/mbar'") &&
      !src.includes('"SID":"wnd[0]/mbar"')
    )
      continue;
    const names: string[] = [];
    for (const m of execAll(
      src,
      /lsdata="\{1:'((?:[^'\\]|\\.)*)'[^"]*?SID:'wnd\[0\]\/mbar\/(menu\[\d+\])'/g,
    ))
      names.push(`${unesc(m[1] ?? "")} {${m[2]}}`);
    // S/4HANA 2025 writes the template's lsdata as JSON in single quotes.
    if (!names.length)
      for (const m of execAll(src, /lsdata='(\{[^']*\})'/g)) {
        try {
          const o = JSON.parse(m[1] ?? "") as Record<string, unknown>;
          const sidObj = Object.values(o).find(
            (v) => v && typeof v === "object" && "SID" in (v as object),
          ) as { SID?: string } | undefined;
          const top = /^wnd\[0\]\/mbar\/(menu\[\d+\])$/.exec(sidObj?.SID ?? "");
          if (top && typeof o["1"] === "string")
            names.push(`${o["1"]} {${top[1]}}`);
        } catch {
          /* not JSON */
        }
      }
    // The entries below the top menus are not on this line: the view of the menu bar alone lists them all.
    if (names.length) {
      out(0, `wnd[0]/mbar  menubar  ${names.join(", ")}  (every entry and its path: look id "mbar")`);
      mbarShown = true;
    }
    break;
  }
  // A menu that was opened once is a template no more: Web GUI has drawn its rows into the page and keeps
  // them there, far above the window, after the menu is closed (measured on ECC). The line is read from them.
  if (!mbarShown) {
    const tops = Array.from(document.querySelectorAll("tr[ct^='POMN']")).filter((tr) => /^wnd\[0\]\/mbar\/menu\[\d+\]$/.test(tr.id));
    const names = tops.map((tr) => `${prop(tr.getAttribute("data-ls") ?? "", 1) || norm(tr.textContent)} {${tr.id.slice("wnd[0]/mbar/".length)}}`);
    // While the menu is open its rows are in the view as "menu" lines (below).
    if (names.length && !tops.some((tr) => visible(tr) && inView(tr))) out(0, `wnd[0]/mbar  menubar  ${names.join(", ")}  (every entry and its path: look id "mbar")`);
  }
  // Open popup menus: rows whose DOM id is the scripting id.
  // A closed menu stays in the page, moved far above the window (top -9999 px): only rows in the window are open.
  // The menu of a dropdown button names its rows u1234 in the page, a new number each time it opens: their
  // scripting id (in lsdata) stays, so that is the id shown.
  for (const tr of Array.from(document.querySelectorAll("tr[ct^='POMN']"))) {
    if (!visible(tr) || !inView(tr) || tr.id.startsWith("sysInfoArea")) continue;
    const text = norm((tr as HTMLElement).innerText);
    const own = tr.id.startsWith("wnd[") ? "" : info(tr).sid;
    // Web GUI's own entries in the menu bar's menu (its file browser, Settings, About) are not SAP's: they have no scripting id of their own.
    if (/^wnd\[\d+\]\/mbar\/(\[\d+\])?$/.test(own)) continue;
    if (text || own) out(0, `${own.startsWith("wnd[") ? own : tr.id}  menu  ${text}`);
  }

  // System information: transaction, program and screen.
  const sys = (k: string) =>
    prop(
      document
        .getElementById(`sysInfoAreaMenuItemSAPITS_MBAR_${k}`)
        ?.getAttribute("data-ls") ?? "",
      13,
    );
  let [program, screen] = sys("DYNPRO").split("/");
  let transaction = sys("TRANSACTION");
  // S/4HANA 2025 has no system information area: the current screen names a
  // style element (customstyle-SAPMV45A4001), and the start transaction is in
  // Web GUI's start configuration (urltxstr:'*VA03 …').
  if (!program) {
    const styles = Array.from(
      document.querySelectorAll("style[id^='customstyle-']"),
    );
    const m = /^customstyle-(.+?)(\d{4})$/.exec(
      styles[styles.length - 1]?.id ?? "",
    );
    if (m) [program, screen] = [m[1], m[2]];
  }
  // Without that area (Web GUI inside the launchpad of S/4HANA 2025), Web GUI's own state names the transaction
  // of the screen (sap.its.arrSystemParams["t-code"], measured: VA03 after /nVA03 from a VA01 tile).
  if (!transaction) {
    const live = (window as unknown as { sap?: { its?: { arrSystemParams?: Record<string, unknown> } } }).sap?.its?.arrSystemParams?.["t-code"];
    if (typeof live === "string" && /^[A-Z0-9_/.]+$/i.test(live)) transaction = live.toUpperCase();
  }
  if (!transaction) {
    const m = /urltxstr:'\*?([A-Z0-9_/]+)/.exec(
      document.documentElement.innerHTML,
    );
    if (m?.[1]) transaction = `${m[1]} (start)`;
  }
  const windows = [...lines.keys()]
    .sort((a, b) => a - b)
    .map((k) => ({
      id: `wnd[${k}]`,
      title: titles.get(k) ?? "",
      lines: lines.get(k)!,
    }));
  const system = Array.from(document.querySelectorAll("#msgarea [ct='TV']"))
    .filter((x) => !x.closest("[id='wnd[0]/sbar_msg']"))
    .map((x) => norm((x as HTMLElement).innerText))
    .filter(Boolean)
    .join(" ");
  return {
    transaction,
    program: program ?? "",
    screen: screen ?? "",
    system,
    windows,
  };
}

/** One of Web GUI's own dialogs (session timeout, connection lost): see extractClientPopups. */
export interface ClientPopup {
  id: string;
  title: string;
  text: string;
  buttons: string[];
}

/**
 * Web GUI's own dialogs (session timeout, connection lost) are popup windows
 * of the page, not SAP windows: they carry no scripting id, so extractLook
 * does not list them, yet they block the screen. The reader lists them as
 * WINDOW browser.
 */
export function extractClientPopups(): ClientPopup[] {
  const out: ClientPopup[] = [];
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("div[ct^='PW']"))) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.offsetWidth === 0) continue;
    // An SAP popup window holds controls with scripting ids; those are read by extractLook.
    if (el.querySelector("[lsdata*='wnd[']")) continue;
    // ECC, then the popup of S/4HANA 2025 (ct="PW_standards": a header with a heading, a content section).
    const title = clean(el.querySelector(".urPWTitleText,[id$='-header-title-txt'],[role='heading']")?.textContent);
    const body = el.querySelector<HTMLElement>(".urPWContent,.lsPWNewContentSection");
    const buttons = Array.from(el.querySelectorAll<HTMLElement>("[ct='B'],button,[role='button']"))
      .map((b) => clean(b.textContent))
      .filter((t) => t.length > 0);
    const text = clean(body?.innerText);
    out.push({ id: el.id, title, text, buttons });
  }
  return out;
}

/**
 * The HTML viewers of the screen (frames inside the Web GUI frame), by
 * scripting id and the DOM id of their iframe. Runs after normalizeLsdata.
 */
export function extractViewerIds(): { sid: string; dom: string }[] {
  return Array.from(document.querySelectorAll("iframe[data-ls*=\"Type:'GuiHtmlViewer'\"]"))
    .filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => ({
      sid: /SID:'((?:[^'\\]|\\.)*)'/.exec(e.getAttribute("data-ls") ?? "")?.[1] ?? "",
      dom: e.id,
    }));
}

/**
 * The highest window number on screen: 0 when no popup is open. Runs in the
 * Web GUI frame; reads `lsdata` itself.
 */
export function topWindowOpen(): number {
  let max = 0;
  for (const el of Array.from(document.querySelectorAll("[lsdata*='wnd[']"))) {
    const m = /wnd\[(\d+)\]/.exec(el.getAttribute("lsdata") ?? "");
    if (m && (el as HTMLElement).offsetWidth > 0) max = Math.max(max, Number(m[1]));
  }
  // A dialog shell (the error log of an editable grid) is a popup whose controls keep ids of wnd[0]: its ModalNo says it is one.
  for (const el of Array.from(document.querySelectorAll("div[ct='PW'][lsdata]"))) {
    const m = /"?ModalNo"?:(\d+)/.exec(el.getAttribute("lsdata") ?? "");
    if (m && (el as HTMLElement).offsetWidth > 0) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * The DOM id of the open menu row this id names (its DOM id, or its scripting
 * id as the view shows it); "" when no such row is open. A row of a popup
 * menu (a context menu, a dropdown button's menu, the ">>" menu of a
 * toolbar). A closed menu stays in the page far above the window.
 */
export function menuRowOpen(rowId: string): string {
  const open = (tr: Element | null): tr is Element => {
    if (!tr || tr.tagName !== "TR" || !(tr.getAttribute("ct") ?? "").startsWith("POMN")) return false;
    const r = tr.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  };
  const byId = document.getElementById(rowId);
  if (open(byId)) return byId.id;
  if (!rowId.startsWith("wnd[")) return "";
  // A row of a dropdown button's menu is named by its scripting id: lsdata holds it, the DOM id is u1234.
  for (const tr of Array.from(document.querySelectorAll("tr[ct^='POMN']"))) {
    const ls = tr.getAttribute("data-ls") ?? tr.getAttribute("lsdata") ?? "";
    const sid = (/"?SID"?:["']((?:[^'"\\]|\\.)*)["']/.exec(ls)?.[1] ?? "").replace(/\\\\/g, "\\");
    if (sid === rowId && tr.id && open(tr)) return tr.id;
  }
  return "";
}

/** Is an entry below this menu entry open (drawn in the window)? Its submenu is then on screen. */
export function submenuOpen(sid: string): boolean {
  return Array.from(document.querySelectorAll("tr[ct^='POMN']")).some((tr) => {
    if (!tr.id.startsWith(`${sid}/`)) return false;
    const r = tr.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  });
}

/**
 * What is open above the screen and closes with Escape alone: "menubar" for
 * the menu bar's menu, "menu" for another popup menu (a context menu, a
 * dropdown button's menu, the ">>" menu of a toolbar), "list" for the list of a dropdown or of a
 * field's earlier entries; "" when nothing is. Web GUI keeps Escape for
 * these and sends SAP nothing (measured on ECC: the menu or list closed, no
 * request). A closed menu stays in the page far above the window.
 */
export function openOverlay(): "menubar" | "menu" | "list" | "" {
  const open = (e: Element): boolean => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility === "visible";
  };
  const rows = Array.from(document.querySelectorAll("tr[ct^='POMN']")).filter((tr) => !tr.id.startsWith("sysInfoArea") && open(tr));
  // The menu bar's menu (behind the Menu button) keeps its top level open when Escape closes a submenu.
  if (rows.some((tr) => /^wnd\[0\]\/mbar\/menu\[\d+\]$/.test(tr.id))) return "menubar";
  if (rows.length) return "menu";
  if (Array.from(document.querySelectorAll("[role='listbox'],.lsListbox,[ct='LIB']")).some(open)) return "list";
  return "";
}

/**
 * Runs in an HTML viewer's frame: its form controls and links, numbered, and
 * the text it shows (the documentation of F1, the long text of a message),
 * one entry per line of the page, at most `text` characters; `more` counts
 * the characters left out.
 */
export function extractViewer(a: { start: number; text: number }): {
  lines: string[];
  next: number;
  text: string[];
  more: number;
} {
  const norm = (s: string | null | undefined) =>
    (s ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  const out: string[] = [];
  let n = a.start;
  for (const el of Array.from(
    document.querySelectorAll(
      "select,input:not([type=hidden]),textarea,button,a[href]",
    ),
  )) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    n++;
    el.setAttribute("data-sap-html", String(n));
    const lab =
      norm(
        el.id
          ? document.querySelector(`label[for="${el.id}"]`)?.textContent
          : "",
      ) ||
      norm(el.getAttribute("title")) ||
      norm(el.getAttribute("aria-label"));
    if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      const opts = Array.from(s.options).map(
        (o) => `${o.value}:${norm(o.text)}`,
      );
      out.push(
        `html[${n}]  dropdown  ${lab} = "${s.value}" ${norm(s.options[s.selectedIndex]?.text)}  options: ${opts.slice(0, 30).join(", ")}`,
      );
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const i = el as HTMLInputElement;
      if (i.type === "checkbox" || i.type === "radio")
        out.push(`html[${n}]  ${i.type}  [${i.checked ? "x" : " "}] ${lab}`);
      else if (
        i.type === "button" ||
        i.type === "submit" ||
        i.type === "image" ||
        i.type === "reset"
      )
        out.push(`html[${n}]  button  ${norm(i.value) || lab}`);
      else if (i.type === "password")
        // A password is never written out.
        out.push(
          `html[${n}]  field  ${lab} = "${i.value ? "***" : ""}"  (${i.readOnly || i.disabled ? "read-only" : "edit"})`,
        );
      else
        out.push(
          `html[${n}]  field  ${lab} = "${norm(i.value)}"  (${i.readOnly || i.disabled ? "read-only" : "edit"})`,
        );
    } else {
      const t = norm((el as HTMLElement).innerText) || lab;
      if (t)
        out.push(`html[${n}]  ${el.tagName === "A" ? "link" : "button"}  ${t}`);
    }
  }
  // The text as the page shows it: one entry per line, the cells of a table row with " | " between them.
  // A line that is only the text of a button or a link is left out (its control line says it).
  const pressed = [...new Set(Array.from(document.querySelectorAll("button,a[href]")).map((b) => norm((b as HTMLElement).innerText)))].filter(Boolean).sort((x, y) => y.length - x.length);
  const onlyControls = (t: string) => {
    let rest = t;
    for (const p of pressed) rest = rest.split(p).join("");
    return !rest.replace(/[\s|]/g, "");
  };
  const text: string[] = [];
  let more = 0;
  let left = a.text;
  for (const raw of (document.body?.innerText ?? "").split("\n")) {
    const t = norm(raw.replace(/\t+/g, " | ")).replace(/^(\| )+|( \|)+$/g, "");
    if (!t || onlyControls(t)) continue;
    if (left <= 0) more += t.length;
    else if (t.length > left) {
      text.push(`${t.slice(0, left)}...`);
      more += t.length - left;
    } else text.push(t);
    left -= t.length;
  }
  return { lines: out, next: n, text, more };
}

/**
 * Web GUI of ECC writes `lsdata` as a JavaScript object literal
 * (`{SID:'wnd[0]/usr/ctxtVBAK-AUART',Type:'GuiCTextField'}`); Web GUI of
 * S/4HANA 2025 writes strict JSON (`{"SID":"wnd[0]/usr/…","Type":"…"}`,
 * measured on a 2025 system). This copies every `lsdata` into `data-ls` in the ECC form, so the
 * reader reads one form. Web GUI's own attribute is left as it is. Runs in
 * the frame before each read; elements already copied are skipped.
 */
export function normalizeLsdata(): number {
  const lit = (v: unknown): string => {
    if (typeof v === "string") {
      // S/4HANA 2025 writes the ids of a table cell's input as JSON inside a string ("21":"{\"SID\":...}").
      if (v.startsWith('{"SID":')) {
        try {
          return lit(JSON.parse(v));
        } catch {
          /* a text that only looks like it */
        }
      }
      return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    }
    if (Array.isArray(v)) return `[${v.map(lit).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${k}:${lit(x)}`)
        .join(",")}}`;
    return String(v);
  };
  /** A cell of a classic list by the kind of its element: text, icon, checkbox. */
  const LIST_CELL_TYPES: Record<string, string> = { ALT: "ABAPLISTTEXT", ALI: "ABAPLISTIMAGE", ALC: "ABAPLISTCHECKBOX" };
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("[lsdata]"))) {
    const ls = el.getAttribute("lsdata") ?? "";
    if (el.getAttribute("data-ls-src") === ls) continue;
    let out = ls;
    if (ls.startsWith('{"')) {
      try {
        out = lit(JSON.parse(ls));
      } catch {
        /* keep the original */
      }
    }
    // S/4HANA 2025 does not type the cells of a classic list (only {"SID":"wnd[1]/usr/lbl[1,4]"}): the element's
    // own kind says what the cell is, as ECC's Type does. Without it no row of such a list was read.
    const cell = LIST_CELL_TYPES[el.getAttribute("ct") ?? ""];
    if (cell && /SID:'/.test(out) && !/[{,]Type:'/.test(out)) out = out.replace(/SID:'((?:[^'\\]|\\.)*)'/, `SID:'$1',Type:'${cell}'`);
    el.setAttribute("data-ls", out);
    el.setAttribute("data-ls-src", ls);
    n++;
  }
  return n;
}

export interface MarkedControl {
  sid: string;
  type: string;
  modal: number;
  checked: boolean;
  readonly: boolean;
  tag: string;
  /** For an input element: its type ("text", "password", ...); "" otherwise. */
  inputType: string;
  /** A toolbar button behind the toolbar's ">>" button: the DOM id of that ">>" button (of the toolbar when it shows none); "" otherwise. */
  overflow: string;
  /** The button's DOM id ("" when not a button): its entry in the ">>" menu is "<id>-BtnMenu". */
  dom: string;
  /** A field drawn as text until it is clicked (a table cell of S/4HANA 2025, <span role="textbox">): a click makes it an input. */
  drawnAsText: boolean;
  /** A button, tab or menu entry SAP shows greyed out: a click on it does nothing. */
  disabled: boolean;
}

/** Runs in the Web GUI frame: marks the control an id names and describes it. */
export function markControl(ident: string): MarkedControl | string {
  for (const e of Array.from(document.querySelectorAll("[data-sap-act]")))
    e.removeAttribute("data-sap-act");
  const info = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? "";
    const raw =
      /OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1];
    return {
      sid: raw ? raw.replace(/\\\\/g, "\\") : "",
      type: /[{,]Type:'([^']*)'/.exec(ls)?.[1] ?? "",
      // S/4HANA 2025 writes ModalNo only on the window itself: the control's window is the one its id names.
      modal: Number(/ModalNo:(\d+)/.exec(ls)?.[1] ?? /^wnd\[(\d+)\]/.exec(raw ?? "")?.[1] ?? 0),
    };
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      (el as HTMLElement).checkVisibility?.() !== false
    );
  };
  /** A toolbar button moved behind the toolbar's ">>" button: its ">>" button, else null. */
  const overflowOf = (el: Element): Element | null => {
    if (!/Type:'Gui(Button|ToggleButton|DropDownButton)'/.test(el.getAttribute("data-ls") ?? "")) return null;
    if (!el.closest(".lsToolbar--item-hidden")) return null;
    const bar = el.closest("[ct='T']");
    if (!bar || !visible(bar)) return null;
    // ECC names the ">>" button <toolbar>-hiddenOpener; S/4HANA 2025 puts a button in an item of its own
    // (lsToolbar--overflowButton). A toolbar that shows neither still hides the button: the toolbar stands in.
    const named = document.getElementById(`${bar.id}-hiddenOpener`);
    if (named && visible(named)) return named;
    const own = Array.from(bar.querySelectorAll(".lsToolbar--overflowButton [ct='B'],.lsToolbar--overflowButton [role='button']")).find(visible);
    return own ?? named ?? bar;
  };
  const all = Array.from(document.querySelectorAll("[data-ls*='SID:']"))
    .map((el) => ({ el, ...info(el) }))
    .filter((x) => x.sid && (visible(x.el) || overflowOf(x.el)));
  // Table cells: the input or checkbox inside the cell, not the cell itself.
  const pick = (xs: typeof all) => {
    const inner = xs.filter(
      (x) => x.type !== "SAPTABLECSCELL" && x.type !== "GuiGridViewCell",
    );
    // A field and its label share the SAP name (ctxtVBAK-VKORG, lblVBAK-VKORG): the id means the field.
    const controls = (inner.length ? inner : xs).filter((x) => x.type !== "GuiLabel");
    return controls.length ? controls : inner.length ? inner : xs;
  };
  let want = ident.replace(/^ +| +$/g, "");
  let hits = pick(all.filter((x) => x.sid === want));
  // An id that names its window (wnd[1]/...) means a control of that window only.
  let pool = all;
  if (!hits.length && want.startsWith("wnd[")) {
    const wnd = want.slice(0, want.indexOf("]") + 1);
    pool = all.filter((x) => x.sid.startsWith(`${wnd}/`));
    want = want.slice(want.lastIndexOf("/") + 1);
  }
  if (!hits.length) hits = pick(pool.filter((x) => x.sid.endsWith(`/${want}`)));
  if (!hits.length) {
    // A field's SAP name (VBAK-AUART): the id's last segment without its type prefix.
    hits = pick(
      pool.filter(
        (x) =>
          x.sid.slice(x.sid.lastIndexOf("/") + 1).replace(/^[a-z]+/, "") ===
          want,
      ),
    );
  }
  if (!hits.length) return `no control named ${ident}`;
  const top = Math.max(...hits.map((h) => h.modal));
  hits = hits.filter((h) => h.modal === top);
  const clsOf = (el: Element | null | undefined) => {
    const c = (el as HTMLElement | null | undefined)?.className;
    return typeof c === "string" ? c : "";
  };
  // Read-only as Web GUI marks it: on the field's frame (lsField--readonly), on a checkbox's class
  // (lsCheckBox--checked--disabled). A dropdown is an <input readonly> by construction: its readOnly says nothing.
  const ro = (el: Element) => {
    const i = el as HTMLInputElement;
    const ls = el.getAttribute("data-ls") ?? "";
    if (/Type:'Gui(CheckBox|RadioButton)'/.test(ls)) return /--disabled\b|--readonly\b/.test(clsOf(el)) || el.getAttribute("aria-disabled") === "true";
    const frame = clsOf(el.closest(".lsField"));
    if (/lsField--(readonly|disabled)\b/.test(frame)) return true;
    if (i.disabled === true || el.getAttribute("aria-readonly") === "true" || el.getAttribute("aria-disabled") === "true") return true;
    if (/--readonly|--disabled/.test(clsOf(el.parentElement))) return true;
    const list = el.getAttribute("ct") === "CB" || /lsField--list\b/.test(frame) || /Type:'GuiComboBox'/.test(ls);
    return !list && i.readOnly === true;
  };
  hits.sort((a, b) => Number(ro(a.el)) - Number(ro(b.el)));
  // A filter of the value help dialog of S/4HANA 2025 and its frame share the id: the token field itself is meant.
  const h = hits.find((x) => x.type === "GuiSearchHelpHeaderItem" && x.el.getAttribute("ct") === "TOKENIZER") ?? hits[0]!;
  // What a click or typing goes to. The closed restrictions panel of a value help opens with the arrow
  // left of its title (a click on the title does nothing); a calendar is typed into in its date field.
  let target = h.el;
  if (h.type === "GuiSearchHelpPage") {
    const stack = h.el.closest("table[ct='PST']");
    const toggle = stack ? document.getElementById(`${stack.id}-tgl`) : null;
    if (toggle && /TglIconCol\b/.test(clsOf(toggle))) target = toggle;
  } else if (h.type === "GuiCalendar") target = h.el.querySelector("input[ct='I']") ?? h.el;
  else if (h.type === "GuiStatusBar") {
    // The status bar is clicked on its message: that opens the message's long text. (Its middle holds the SAP
    // logo, whose double-click starts a support message.) Web GUI sends the click only when the text it drew
    // is the text SAP sent, character by character, and it draws several spaces in a row as "&nbsp;": the
    // text is written back as SAP sent it, which looks the same.
    const msg = document.getElementById(`${h.sid}_msg`);
    const txt = document.getElementById(`${h.sid}_msg-txt`);
    const sent = /applicationText:'((?:[^'\\]|\\.)*)'/.exec(msg?.getAttribute("data-ls") ?? msg?.getAttribute("lsdata") ?? "")?.[1];
    if (txt && sent !== undefined && txt.innerHTML !== sent && txt.innerHTML.replace(/&nbsp;/g, " ") === sent) txt.textContent = sent;
    target = txt ?? msg ?? h.el;
  }
  // A filter of the value help dialog of S/4HANA 2025 is a token field: its input is typed into.
  else if (h.type === "GuiSearchHelpHeaderItem") target = h.el.querySelector("input") ?? h.el;
  const typed = h.type === "GuiSearchHelpHeaderItem" ? target : h.el;
  target.setAttribute("data-sap-act", "1");
  const cls = clsOf(h.el);
  // The class says the state the page shows; the hidden input keeps what the server drew.
  let checked: boolean;
  if (/--(unchecked|unselected)\b/.test(cls)) checked = false;
  else if (/--(checked|selected)\b/.test(cls)) checked = true;
  else if (h.el.querySelector(".urCImgOn,.lsCBImgSel")) checked = true;
  else if (h.el.querySelector(".urCImgOff")) checked = false;
  else if (h.el.getAttribute("aria-checked")) checked = h.el.getAttribute("aria-checked") === "true";
  else checked = (h.el.querySelector("input") as HTMLInputElement | null)?.checked === true;
  const opener = overflowOf(h.el);
  return {
    sid: h.sid,
    type: h.type,
    modal: h.modal,
    checked,
    readonly: ro(typed),
    tag: typed.tagName,
    inputType:
      typed.tagName === "INPUT" ? (typed as HTMLInputElement).type || "text" : "",
    overflow: opener && !visible(h.el) ? opener.id : "",
    dom: h.el.id,
    drawnAsText: h.el.tagName !== "INPUT" && h.el.tagName !== "TEXTAREA" && h.el.getAttribute("role") === "textbox" && /^Gui(C?Text|Password)Field$/.test(h.type),
    disabled: /^Gui(Button|ToggleButton|DropDownButton|Tab)$/.test(h.type) && (/--disabled\b|Dsbl\b/.test(cls) || h.el.getAttribute("aria-disabled") === "true"),
  };
}

/**
 * A row of a smart table (grid, tree, value-help list) and one of its cells,
 * marked for Playwright; with a column and no row or node, the column's
 * header. A column the table does not have is said, not guessed.
 */
export function markRow(a: { sid: string; row?: number | undefined; node?: string | undefined; col?: string | number | undefined }): string {
  // Web GUI of S/4HANA 2025 breaks String.prototype.matchAll (as Web GUI breaks trim): loop with exec.
  const execAll = (text: string, re: RegExp): RegExpExecArray[] => {
    const out: RegExpExecArray[] = [];
    const g = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`,
    );
    for (let m = g.exec(text); m; m = g.exec(text)) out.push(m);
    return out;
  };
  for (const e of Array.from(document.querySelectorAll("[data-sap-act]")))
    e.removeAttribute("data-sap-act");
  const sidOf = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? "";
    return (
      /OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      ""
    ).replace(/\\\\/g, "\\");
  };
  const roots = Array.from(
    document.querySelectorAll(
      "[data-ls*=\"Type:'GuiGridView'\"],[data-ls*=\"Type:'GuiTree'\"],[data-ls*=\"Type:'GuiSearchHelpResult'\"],[data-ls*=\"Type:'GuiValueHelpResult'\"]",
    ),
  ).filter((el) => el.getBoundingClientRect().width > 0);
  const want = a.sid;
  const root =
    roots.find((el) => sidOf(el) === want) ??
    // Without an id, the only tree or grid of the screen. An id that names none is not guessed:
    // it may come from an earlier screen, and the one grid here is then another control.
    (want === "" && roots.length === 1 ? roots[0] : undefined);
  if (!root) return `no tree or grid named ${want || "(no id given)"} on this screen`;
  const tds = Array.from(
    root.querySelectorAll("td[lsmatrixrowindex][lsmatrixcolindex]"),
  ).filter((td) => td.getAttribute("subct") !== "SC");
  let rowIdx: number | undefined;
  if (a.node !== undefined) {
    const strip = (s: string) =>
      s.replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
    const ls = root.getAttribute("data-ls") ?? "";
    const keys = [
      ...execAll(
        /nodeindexes:\[(.*?)\]\]/.exec(ls)?.[1] ?? "",
        /\['((?:[^'\\]|\\.)*)',/g,
      ),
    ].map((x) => strip(x[1] ?? ""));
    const want = strip(String(a.node));
    const rows = Array.from(root.querySelectorAll("tr[iidx]"));
    const keyOf = (t: Element) =>
      strip((t.getAttribute("dddata") ?? "").split("#")[0] ?? "") ||
      keys[Number(t.getAttribute("iidx"))] ||
      "";
    // A node key; failing that, the node's text as the view shows it.
    const tr =
      rows.find((t) => keyOf(t) === want) ??
      rows.find(
        (t) =>
          want &&
          strip((t as HTMLElement).innerText).startsWith(
            want.split(" | ")[0] ?? want,
          ),
      );
    if (!tr) return `no node ${a.node}`;
    // The node's own row number in the table: a tree with a header row starts its nodes at 1, one without at 0.
    const own = tr.querySelector("td[lsmatrixrowindex]");
    rowIdx = own ? Number(own.getAttribute("lsmatrixrowindex")) : Number(tr.getAttribute("iidx")) + 1;
  } else rowIdx = Number(a.row ?? 0) + 1;
  // The column `col` names: by its id (VBELN), its title, or its number counted from 0.
  const colIds = (/ColumnI[dD]s:\[([^\]]*)\]/.exec(root.getAttribute("data-ls") ?? "")?.[1] ?? "")
    .split(",")
    .filter(Boolean)
    .map((x) => x.replace(/^'|'$/g, ""));
  const ths = Array.from(root.querySelectorAll("th[lsmatrixcolindex]"));
  const column = (col: string): { th: Element | undefined; ci: number } => {
    const th =
      ths.find((t) => sidOf(t).endsWith(`/col${col}`)) ??
      ths.find((t) =>
        (t.getAttribute("title") ?? (t as HTMLElement).innerText)
          .replace(/\s+/g, " ")
          .includes(col),
      );
    let ci = th ? Number(th.getAttribute("lsmatrixcolindex")) : NaN;
    if (Number.isNaN(ci) && colIds.indexOf(col) >= 0) ci = colIds.indexOf(col) + 1;
    if (Number.isNaN(ci) && /^\d+$/.test(col) && (!colIds.length || Number(col) < colIds.length)) ci = Number(col) + 1;
    return { th: th ?? ths.find((t) => Number(t.getAttribute("lsmatrixcolindex")) === ci), ci };
  };
  const noColumn = (col: string) => `no column ${col} in ${sidOf(root)}${colIds.length ? `: its columns are ${colIds.slice(0, 60).join(", ")}${colIds.length > 60 ? ", ..." : ""}` : ""}`;
  // An item of a tree node (an icon that is a link), named as the view names it.
  if (a.node !== undefined && a.col !== undefined && a.col !== "") {
    const tr = tds.find((td) => Number(td.getAttribute("lsmatrixrowindex")) === rowIdx)?.closest("tr");
    const item = Array.from(tr?.querySelectorAll("a[ct='LN']") ?? []).find((e) => e.id.endsWith(`#${a.col}#i`));
    if (item) {
      item.setAttribute("data-sap-act", "cell");
      return "ok";
    }
  }
  const named = a.col !== undefined && a.col !== "" ? column(String(a.col)) : undefined;
  if (named && Number.isNaN(named.ci)) return noColumn(String(a.col));
  // A column without a row or a node: the column itself, by its header.
  if (named && a.row === undefined && a.node === undefined) {
    const r = named.th?.getBoundingClientRect();
    if (!named.th || !r || r.width <= 0 || r.height <= 0) return `the header of column ${a.col} is not on screen`;
    named.th.setAttribute("data-sap-act", "cell");
    return "ok";
  }
  // Only rows that are drawn: Web GUI keeps rows it scrolled away from in the page, without a size.
  const box = root.getBoundingClientRect();
  const drawn = (td: Element) => {
    const r = td.getBoundingClientRect();
    return r.height > 0 && r.bottom > box.top + 2 && r.top < box.bottom - 2;
  };
  const inRow = tds.filter(
    (td) => Number(td.getAttribute("lsmatrixrowindex")) === rowIdx && drawn(td),
  );
  if (!inRow.length) return `row ${a.row ?? a.node} is not on screen`;
  let cell: Element | undefined;
  if (named) cell = inRow.find((td) => Number(td.getAttribute("lsmatrixcolindex")) === named.ci);
  const hicCell = inRow.find((td) => td.getAttribute("subct") === "HIC");
  const isTree = /Type:'GuiTree'/.test(root.getAttribute("data-ls") ?? "");
  // A tree node is opened on its text (in the hierarchy cell); a grid row on its first filled cell.
  // (The first text element of the cell is an empty one without a size: a click on it waited 5 s and hit nothing.)
  if (!cell && isTree && hicCell)
    cell =
      Array.from(hicCell.querySelectorAll("[ct='TV']")).find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) ?? hicCell;
  cell ??=
    inRow.find(
      (td) =>
        td.getAttribute("subct") !== "HIC" &&
        (td as HTMLElement).innerText.replace(/\s/g, ""),
    ) ?? inRow[0];
  cell!.setAttribute("data-sap-act", "cell");
  // Hierarchy cell: the expander icon and the node text.
  const hic = inRow.find((td) => td.getAttribute("subct") === "HIC");
  const exp = hic?.querySelector(
    "[acf*='EXP'],[acf*='COL'],[class*='Exp'],[class*='Col']",
  );
  exp?.setAttribute("data-sap-act", "expander");
  return "ok";
}

/**
 * The row selector of a row (the button at the left of a grid, table
 * control or value-help list row), marked for Playwright, and whether its row
 * is selected now. `row` counts as the view does: from 0, on screen for a
 * table control, in the whole list for a grid. A text when there is none.
 */
export function markSelector(a: { sid: string; row: number }): { selected: boolean } | string {
  for (const e of Array.from(document.querySelectorAll("[data-sap-act]")))
    e.removeAttribute("data-sap-act");
  const sidOf = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? "";
    return (
      /OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ??
      ""
    ).replace(/\\\\/g, "\\");
  };
  const root = Array.from(
    document.querySelectorAll(
      "[data-ls*=\"Type:'GuiGridView'\"],[data-ls*=\"Type:'GuiTableControl'\"],[data-ls*=\"Type:'GuiSearchHelpResult'\"],[data-ls*=\"Type:'GuiValueHelpResult'\"]",
    ),
  ).find((el) => el.getBoundingClientRect().width > 0 && sidOf(el) === a.sid);
  if (!root) return `no grid or table named ${a.sid} on this screen`;
  const cells = Array.from(root.querySelectorAll("td[subct='SC'][lsmatrixrowindex]"));
  if (!cells.length) return `the rows of ${a.sid} cannot be selected (it has no row selector)`;
  const box = root.getBoundingClientRect();
  const sc = cells.find((td) => {
    if (Number(td.getAttribute("lsmatrixrowindex")) !== a.row + 1) return false;
    const r = td.getBoundingClientRect();
    return r.height > 0 && r.bottom > box.top + 2 && r.top < box.bottom - 2;
  });
  if (!sc) return `row ${a.row} is not on screen`;
  sc.setAttribute("data-sap-act", "selector");
  const cls = `${sc.className} ${sc.firstElementChild?.className ?? ""}`;
  return { selected: !/UnSel/.test(cls) && /urSTRowSel|LbSelIcon|Sel2BgColor/.test(cls) };
}

export interface MenuEntry {
  /** Scripting id: wnd[0]/mbar/menu[0]/menu[3], or a toolbar button's id for entries of the System menu. */
  sid: string;
  text: string;
  /** Shortcut as Web GUI names it: F8, SHIFT_F3, CTRL_S, ESCAPE; "" when none. */
  key: string;
  /** SAP shows the entry greyed out on this screen: choosing it does nothing. */
  disabled?: true;
}

/**
 * Every entry of the menu bar and its submenus, with its shortcut. Web GUI
 * keeps the menus as HTML templates behind the Menu button; each entry's
 * `lsdata` holds its text (key 1), its shortcut (key 15) and its scripting id
 * (key 18). The guard uses this to know what a menu entry or a function key does.
 */
export function extractMenus(): MenuEntry[] {
  const execAll = (text: string, re: RegExp): RegExpExecArray[] => {
    const out: RegExpExecArray[] = [];
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (let m = g.exec(text); m; m = g.exec(text)) out.push(m);
    return out;
  };
  const unesc = (s: string) =>
    s
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  const prop = (ls: string, key: number): string => {
    const m = new RegExp(`(?:^|[{,])${key}:'((?:[^'\\\\]|\\\\.)*)'`).exec(ls);
    return m ? unesc(m[1] ?? "") : "";
  };
  const out: MenuEntry[] = [];
  const seen = new Set<string>();
  const add = (sid: string, text: string, key: string, disabled = false) => {
    if (!sid || !text || seen.has(sid)) return;
    seen.add(sid);
    out.push({ sid, text, key, ...(disabled ? { disabled: true as const } : {}) });
  };
  // An entry SAP greys out: its row says so (aria-disabled, the class urMnuRowDsbl), in a template as in a drawn menu.
  const greyTag = (tag: string) => /aria-disabled="true"|class="[^"]*\burMnuRowDsbl\b/.test(tag);
  for (const x of Array.from(document.querySelectorAll(".lsMnu--root xmp"))) {
    const src = x.textContent ?? "";
    // ECC: lsdata="{1:'Create',15:'F8',18:{ModalNo:0,SID:'wnd[0]/mbar/menu[0]/menu[3]',Type:'GuiMenu'}}"
    for (const m of execAll(src, /lsdata="(\{1:'[^"]*)"/g)) {
      const ls = m[1] ?? "";
      const sid = /SID:'((?:[^'\\\\]|\\\\.)*)'/.exec(ls)?.[1] ?? "";
      add(sid.replace(/\\\\/g, "\\"), prop(ls, 1), prop(ls, 15), greyTag(src.slice(m.index + m[0].length, src.indexOf(">", m.index + m[0].length) + 1)));
    }
    // S/4HANA 2025 writes the template's lsdata as JSON in single quotes.
    for (const m of execAll(src, /lsdata='(\{[^']*\})'/g)) {
      try {
        const o = JSON.parse(m[1] ?? "") as Record<string, unknown>;
        const sidObj = Object.values(o).find((v) => v && typeof v === "object" && "SID" in (v as object)) as { SID?: string } | undefined;
        if (sidObj?.SID && typeof o["1"] === "string") add(sidObj.SID, o["1"], typeof o["15"] === "string" ? o["15"] : "", greyTag(src.slice(m.index + m[0].length, src.indexOf(">", m.index + m[0].length) + 1)));
      } catch {
        /* not JSON */
      }
    }
  }
  // A menu that was opened once is a template no more: Web GUI has drawn its rows into the page and keeps
  // them there, far above the window, after the menu is closed (measured on ECC: the top level and each
  // submenu that was opened). Those entries are read from the rows.
  for (const tr of Array.from(document.querySelectorAll("tr[ct^='POMN'][lsdata]"))) {
    const ls = tr.getAttribute("lsdata") ?? "";
    let sid = "";
    let text = "";
    let key = "";
    if (ls.startsWith('{"')) {
      try {
        const o = JSON.parse(ls) as Record<string, unknown>;
        const sidObj = Object.values(o).find((v) => v && typeof v === "object" && "SID" in (v as object)) as { SID?: string } | undefined;
        sid = sidObj?.SID ?? "";
        text = typeof o["1"] === "string" ? o["1"] : "";
        key = typeof o["15"] === "string" ? o["15"] : "";
      } catch {
        /* not JSON */
      }
    } else {
      sid = (/SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "").replace(/\\\\/g, "\\");
      text = prop(ls, 1);
      key = prop(ls, 15);
    }
    if (/^wnd\[\d+\]\/mbar\/menu\[/.test(sid)) add(sid, text, key, tr.getAttribute("aria-disabled") === "true" || /\burMnuRowDsbl\b/.test(tr.className));
  }
  return out;
}

export interface PageFacts {
  /** True when the frame holds a Web GUI screen. */
  webgui: boolean;
  system: string;
  client: string;
  user: string;
  transaction: string;
  title: string;
  /** Program of the current screen (SAPMV45A), "" when the page does not say. */
  program: string;
  /** Logon language: the `sap-language` of the address, else the page's `lang`. "" when neither says. */
  language: string;
  /** The page is SAP's logon page, or the logon screen inside Web GUI. */
  logon: boolean;
}

/**
 * Is this frame Web GUI, and whose session is it: system, client, user and
 * transaction from Web GUI's system information items, the title from the
 * window header. Reads `lsdata` directly, so it needs no normalizeLsdata.
 */
export function extractFacts(): PageFacts {
  const unesc = (s: string) =>
    s
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  /** A value of an lsdata, in the ECC form ({13:'VA03'}) or the S/4HANA 2025 form ({"13":"VA03"}). */
  const prop = (ls: string, key: number): string => {
    if (ls.startsWith('{"')) {
      try {
        const v = (JSON.parse(ls) as Record<string, unknown>)[String(key)];
        return typeof v === "string" ? v : "";
      } catch {
        return "";
      }
    }
    const m = new RegExp(`(?:^|[{,])${key}:'((?:[^'\\\\]|\\\\.)*)'`).exec(ls);
    return m ? unesc(m[1] ?? "") : "";
  };
  const sys = (k: string) => norm(prop(document.getElementById(`sysInfoAreaMenuItemSAPITS_MBAR_${k}`)?.getAttribute("lsdata") ?? "", 13));
  const hasSysInfo = !!document.querySelector("[id^='sysInfoAreaMenuItemSAPITS_']");
  const hasOkCode = !!document.getElementById("ToolbarOkCode");
  const webgui = !!document.querySelector("[lsdata]") && (hasSysInfo || hasOkCode);
  let system = sys("SYSTEM");
  let client = sys("CLIENT");
  // Without the system information items (S/4HANA 2025): the status bar shows "S4H (100)".
  if (!system) {
    const bar = Array.from(document.querySelectorAll("#msgarea [ct='TV']"))
      .map((x) => norm((x as HTMLElement).innerText))
      .join(" ");
    const m = /\b([A-Z][A-Z0-9]{2}) ?\((\d{3})\)/.exec(bar);
    if (m) {
      system = m[1] ?? "";
      client ||= m[2] ?? "";
    }
  }
  // The System item can carry the client too: "ABA (800)".
  const both = /^(\S+) ?\((\d{3})\)$/.exec(system);
  if (both) {
    system = both[1] ?? "";
    client ||= both[2] ?? "";
  }
  let transaction = sys("TRANSACTION");
  if (!transaction && webgui) {
    const live = (window as unknown as { sap?: { its?: { arrSystemParams?: Record<string, unknown> } } }).sap?.its?.arrSystemParams?.["t-code"];
    if (typeof live === "string" && /^[A-Z0-9_/.]+$/i.test(live)) transaction = live.toUpperCase();
  }
  if (!transaction && webgui) {
    const m = /urltxstr:'\*?([A-Z0-9_/]+)/.exec(document.documentElement.innerHTML);
    if (m?.[1]) transaction = `${m[1]} (start)`;
  }
  const program = sys("DYNPRO").split("/")[0] ?? "";
  let language = "";
  try {
    language = new URLSearchParams(location.search).get("sap-language") ?? "";
  } catch {
    /* no address to read */
  }
  language ||= document.documentElement.getAttribute("lang") ?? "";
  // SAP's logon page: a password input in a logon form, on a page that is not a Web GUI screen;
  // or the logon screen inside Web GUI (program SAPMSYST).
  const shown = (e: Element) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0;
  const passwords = Array.from(document.querySelectorAll("input[type='password']")).filter(shown);
  const logonForm = !!document.querySelector("#sap-user, [name='sap-user'], [name='sap-password'], #sap-password, form[name='loginForm'], form[name='logonForm'], #LOGON_BUTTON");
  // Screen 40 of SAPMSYST is the old start menu, shown after logon.
  const screenNo = Number(sys("DYNPRO").split("/")[1] ?? NaN);
  const logon = (program === "SAPMSYST" && screenNo !== 40) || (passwords.length > 0 && (logonForm || !webgui));
  return {
    webgui,
    system,
    client,
    user: sys("USER"),
    transaction,
    title: prop(document.getElementById("cuaheader")?.getAttribute("lsdata") ?? "", 1) || norm(document.title),
    program,
    language,
    logon,
  };
}

export interface FocusedControl {
  /** Scripting id of the control that has the focus, "" when it has none. */
  sid: string;
  /** Scripting type; "frame" when the focus is inside a frame (an HTML viewer); "browser" for an element without a scripting id. */
  type: string;
  /** For "browser": a button or a link. */
  pressable: boolean;
  text: string;
}

/**
 * The control that has the keyboard focus, or null when nothing has it.
 * Enter and Space press that control, so the guard needs to know it. Runs in
 * the Web GUI frame after normalizeLsdata.
 */
export function focusedControl(): FocusedControl | null {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae === document.documentElement) return null;
  const facts = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? el.getAttribute("lsdata") ?? "";
    const raw = /"?OrigID"?:["']((?:[^'"\\]|\\.)*)["']/.exec(ls)?.[1] ?? /"?SID"?:["']((?:[^'"\\]|\\.)*)["']/.exec(ls)?.[1];
    return { sid: raw ? raw.replace(/\\\\/g, "\\") : "", type: /[{,]"?Type"?:["']([^'"]*)["']/.exec(ls)?.[1] ?? "" };
  };
  if (ae.tagName === "IFRAME" || ae.tagName === "FRAME") return { sid: facts(ae).sid, type: "frame", pressable: false, text: "" };
  for (let el: Element | null = ae; el; el = el.parentElement) {
    // A row of an open menu.
    if (el.tagName === "TR" && (el.getAttribute("ct") ?? "").startsWith("POMN")) {
      // As the view names the row: its DOM id when that is a scripting id, else the scripting id in its lsdata.
      const own = el.id.startsWith("wnd[") ? "" : facts(el).sid;
      return { sid: own.startsWith("wnd[") ? own : el.id, type: "GuiMenu", pressable: true, text: norm((el as HTMLElement).innerText) };
    }
    const f = facts(el);
    if (f.sid && f.type) return { sid: f.sid, type: f.type, pressable: /Button$/.test(f.type) && f.type !== "GuiRadioButton", text: norm((el as HTMLElement).innerText) || norm(el.getAttribute("title")) };
  }
  // No scripting id: one of Web GUI's own dialogs, or the Menu button.
  let pressable = false;
  for (let el: Element | null = ae; el && !pressable; el = el.parentElement) {
    const role = el.getAttribute("role") ?? "";
    const type = (el as HTMLInputElement).type ?? "";
    pressable = el.tagName === "BUTTON" || el.tagName === "A" || role === "button" || role === "menuitem" || role === "link" || el.getAttribute("ct") === "B" || (el.tagName === "INPUT" && /^(button|submit|image|reset)$/.test(type));
  }
  return { sid: "", type: "browser", pressable, text: norm((ae as HTMLElement).innerText) || norm(ae.getAttribute("title")) || norm(ae.getAttribute("aria-label")) };
}

/** Runs in an HTML viewer's frame: the element that has the focus there. `inner` when the focus is in a frame further in. */
export function viewerFocus(): { pressable: boolean; text: string; inner: boolean } | null {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae === document.documentElement) return null;
  if (ae.tagName === "IFRAME" || ae.tagName === "FRAME") return { pressable: true, text: "", inner: true };
  let pressable = false;
  for (let el: Element | null = ae; el && !pressable; el = el.parentElement) {
    const type = (el as HTMLInputElement).type ?? "";
    pressable = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button" || el.hasAttribute("onclick") || (el.tagName === "INPUT" && /^(button|submit|image|reset)$/.test(type));
  }
  const i = ae as HTMLInputElement;
  const text = ae.tagName === "INPUT" ? (pressable ? norm(i.value) : "") : norm((ae as HTMLElement).innerText);
  return { pressable, text: text || norm(ae.getAttribute("title")) || norm(ae.getAttribute("aria-label")), inner: false };
}

export interface Scrolled {
  /** Scripting id of the control that was scrolled. */
  sid: string;
  /** First row shown before and after, counted from 0. */
  from: number;
  first: number;
  visible: number;
  total: number;
  /** False when this Web GUI gives no access to its scrollbar object: the caller then clicks the scrollbar. */
  moved: boolean;
  /** DOM id of the scrollbar, for the caller's fallback. */
  bar: string;
}

/**
 * Scrolls a grid, a table control, a tree, a value-help list or a classic
 * list to a row. Web GUI draws only the rows in view and asks the server for
 * others when its scrollbar moves, so the scrollbar object is what is moved:
 * its own `scrollToPosition`, which sends that request. The object is not
 * reachable by id; it is caught from the event it handles.
 *
 * `to`: a row counted from 0, or "next", "prev", "first", "last"; "here"
 * moves nothing and says where the control is.
 * Answers a text when there is nothing to scroll.
 */
export function scrollControl(a: { sid: string; to: number | string }): Scrolled | string {
  const sidOf = (el: Element) => {
    const ls = el.getAttribute("data-ls") ?? "";
    return (/OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "").replace(/\\\\/g, "\\");
  };
  const KINDS = /Type:'(GuiTableControl|GuiGridView|GuiTree|GuiSearchHelpResult|GuiValueHelpResult|ABAPLIST)'/;
  const roots = Array.from(document.querySelectorAll("[data-ls*='SID:']")).filter((el) => KINDS.test(el.getAttribute("data-ls") ?? "") && el.getBoundingClientRect().width > 0);
  const root = roots.find((el) => sidOf(el) === a.sid);
  if (!root) return `no grid, table, tree or list named ${a.sid}`;
  // The scrollbars name their control's DOM id in key 6 (tree#105 written tree\x23105).
  const unesc = (x: string) =>
    x.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");
  const sideways = a.to === "right" || a.to === "left" || a.to === "leftmost" || a.to === "rightmost";
  const bar = Array.from(document.querySelectorAll("[ct='SCB']")).find((e) => {
    const ls = e.getAttribute("data-ls") ?? "";
    const owner = unesc(/[{,]6:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "");
    const horizontal = /5:'HORIZONTAL'/.test(ls);
    return owner === root.id && horizontal === sideways && (sideways ? (e as HTMLElement).offsetWidth > 0 : (e as HTMLElement).offsetHeight > 0);
  });
  if (!bar) return sideways ? `all columns of ${a.sid} are on screen: nothing to scroll sideways` : `all rows of ${a.sid} are on screen: nothing to scroll`;
  // The scrollbar's object, from the event it handles: it knows where the list is now. The element's
  // lsdata only says where it was when the server last drew it; a grid that scrolls in the page moves on.
  interface Bar {
    scrollToPosition?: (n: number) => void;
    iGetFirstVisibleItem?: () => number;
    iGetMaxScrollTo?: () => number;
    bPixelDirectMode?: boolean;
    iScrollPos?: number;
    iLargeChange?: number;
    iScrollClipping?: number;
    iScrollRange?: number;
  }
  const w = window as unknown as { UCF_Scrollbar?: { prototype: Record<string, unknown> } };
  const proto = w.UCF_Scrollbar?.prototype;
  let control: Bar | undefined;
  if (proto && typeof proto.onmouseup === "function" && typeof proto.scrollToPosition === "function") {
    const original = proto.onmouseup;
    proto.onmouseup = function (this: Bar) {
      control = this;
    };
    try {
      bar.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } finally {
      proto.onmouseup = original;
    }
  }
  const live = control as Bar | undefined;
  // The horizontal bar of a table control counts pixels, from 0, and its lsdata holds no position: the
  // object says where it is, how far it goes and what a page is. The table draws the columns in the page.
  if (sideways && live?.bPixelDirectMode === true && typeof live.iScrollPos === "number" && typeof live.scrollToPosition === "function") {
    let end = NaN;
    try {
      end = Number(live.iGetMaxScrollTo?.call(live));
    } catch {
      /* read below as "cannot be read" */
    }
    const at = live.iScrollPos;
    const page = Number(live.iLargeChange) > 0 ? Number(live.iLargeChange) : Number(live.iScrollClipping);
    if (Number.isNaN(end) || !(page > 0)) return `the scrollbar of ${a.sid} could not be read`;
    const to = a.to === "right" ? at + page : a.to === "left" ? at - page : a.to === "leftmost" ? 0 : end;
    const next = Math.min(Math.max(0, to), Math.max(0, end));
    const moved: Scrolled = { sid: a.sid, from: at, first: next, visible: page, total: Number(live.iScrollRange) || end + page, moved: true, bar: bar.id };
    if (next !== at) live.scrollToPosition(next);
    return moved;
  }
  const ls = bar.getAttribute("lsdata") ?? "";
  const num = (k: number) => Number(new RegExp(`[{,]"?${k}"?:(-?\\d+)`).exec(ls)?.[1] ?? NaN);
  const asNumber = (f: (() => number) | undefined) => {
    try {
      const v = f?.call(live);
      return typeof v === "number" && v >= 1 ? v : NaN;
    } catch {
      return NaN;
    }
  };
  const livePos = asNumber(live?.iGetFirstVisibleItem);
  const liveMax = asNumber(live?.iGetMaxScrollTo);
  const pos = Number.isNaN(livePos) ? num(0) : livePos;
  const max = Number.isNaN(liveMax) ? num(1) : liveMax;
  // S/4HANA 2025 leaves the page size (key 3) out of a table control's vertical bar: the bar's object holds it.
  const livePage = Number(live?.iLargeChange) > 0 ? Number(live?.iLargeChange) : Number(live?.iScrollClipping) > 0 ? Number(live?.iScrollClipping) : NaN;
  const visible = Number.isNaN(num(3)) ? livePage : num(3);
  const total = num(10);
  if ([pos, max, visible].some((x) => Number.isNaN(x))) return `the scrollbar of ${a.sid} could not be read`;
  let want: number;
  if (typeof a.to === "number") want = a.to + 1;
  else if (a.to === "next" || a.to === "right") want = pos + visible;
  else if (a.to === "prev" || a.to === "left") want = pos - visible;
  else if (a.to === "leftmost") want = 1;
  else if (a.to === "rightmost") want = max;
  else if (a.to === "first") want = 1;
  else if (a.to === "last") want = max;
  else if (a.to === "here") want = pos;
  else return `scroll "to" is a row number, "next", "prev", "first" or "last"; sideways "right", "left", "leftmost" or "rightmost"`;
  want = Math.min(Math.max(1, want), Math.max(1, max));
  const res: Scrolled = { sid: a.sid, from: pos - 1, first: want - 1, visible, total: Number.isNaN(total) ? max + visible - 1 : total, moved: true, bar: bar.id };
  if (want === pos) return res;
  if (!live?.scrollToPosition) return { ...res, first: pos - 1, moved: false };
  live.scrollToPosition(want);
  return res;
}

/**
 * Every entry of a dropdown the page holds, as key and text: [] when Web GUI
 * has not loaded its list yet (it loads some only when the list opens).
 * A text when the id names no dropdown.
 */
export function comboEntries(sid: string): { key: string; text: string }[] | string {
  const unesc = (s: string) =>
    s
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  const prop = (ls: string, key: number): string => {
    const m = new RegExp(`(?:^|[{,])${key}:'((?:[^'\\\\]|\\\\.)*)'`).exec(ls);
    return m ? unesc(m[1] ?? "") : "";
  };
  const norm = (t: string | null | undefined) => (t ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  const el = Array.from(document.querySelectorAll("input[data-ls*=\"Type:'GuiComboBox'\"]")).find((e) => {
    const ls = e.getAttribute("data-ls") ?? "";
    const raw = /OrigID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? /SID:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "";
    return raw.replace(/\\\\/g, "\\") === sid && (e as HTMLElement).offsetWidth > 0;
  });
  if (!el) return `${sid} is not a dropdown on this screen`;
  const ls = el.getAttribute("data-ls") ?? "";
  // S/4HANA 2025 names the list box in aria-controls; ECC in key 2.
  const s4 = /^[A-Z0-9_/]+-[A-Z0-9_]+/.test(prop(ls, 3));
  const lb = document.getElementById(s4 ? (el.getAttribute("aria-controls") ?? "") : prop(ls, 2));
  const out: { key: string; text: string }[] = [];
  for (const it of Array.from(lb?.querySelectorAll("[ct='LIB_I'],[data-itemkey]") ?? [])) {
    const ils = it.getAttribute("data-ls") ?? "";
    const key = it.getAttribute("data-itemkey") ?? (prop(ils, 3) || prop(ils, 1));
    const text = prop(ils, 4) || norm((it as HTMLElement).innerText);
    if (key || text) out.push({ key, text });
  }
  return out;
}


/** The search helps of a field (the tabs of its value help): Web GUI shows one and keeps the others behind a menu. */
export interface SearchHelps {
  /** DOM id of the button that opens the menu of search helps. */
  opener: string;
  entries: { key: string; text: string; dom: string; selected: boolean }[];
}

/**
 * The search helps the value help of a field offers, for the tab `sid`
 * (the one shown). The key of an entry is the letter SAP puts before its
 * name ("T: Material by Material Type"), else its number from 1. A text
 * when the id names no such tab.
 */
export function searchHelps(sid: string): SearchHelps | string {
  const unesc = (s: string) =>
    s
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  const title = (el: Element) => unesc(/(?:^|[{,])8:'((?:[^'\\]|\\.)*)'/.exec(el.getAttribute("data-ls") ?? "")?.[1] ?? "");
  const page = Array.from(document.querySelectorAll("div[ct='P'][data-ls*=\"Type:'GuiSearchHelpPage'\"]")).find((e) => {
    const raw = /SID:'((?:[^'\\]|\\.)*)'/.exec(e.getAttribute("data-ls") ?? "")?.[1] ?? "";
    return raw.replace(/\\\\/g, "\\") === sid && (e as HTMLElement).offsetWidth > 0;
  });
  const stack = page?.closest("table[ct='PST']");
  if (!page || !stack) return `${sid} is not the tab of a value help on this screen`;
  const entries = Array.from(stack.querySelectorAll("div[ct='P']")).map((e, i) => {
    const text = title(e);
    return { key: /^(\S{1,3}): /.exec(text)?.[1] ?? String(i + 1), text, dom: e.id, selected: e === page };
  });
  return { opener: `${stack.id}-menuOpener`, entries };
}


/** Marks the x in the title of the popup in front (data-sap-act="close"): false when it has none. */
export function markWindowClose(): boolean {
  for (const e of Array.from(document.querySelectorAll("[data-sap-act]"))) e.removeAttribute("data-sap-act");
  // A popup window as the view finds it: ct="PW" on ECC, ct="PW_standards" on S/4HANA 2025, or any element that says it is a modal window.
  const open = Array.from(document.querySelectorAll("[ct^='PW'],[lsdata*='GuiModalWindow']")).filter((e) => e.id && (e as HTMLElement).offsetWidth > 0);
  const x = document.getElementById(`${open[open.length - 1]?.id ?? ""}-close`);
  if (!x || x.offsetWidth <= 0) return false;
  x.setAttribute("data-sap-act", "close");
  return true;
}
