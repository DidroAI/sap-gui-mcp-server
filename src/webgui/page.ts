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
    return {
      ls,
      sid: raw ? raw.replace(/\\\\/g, "\\") : "",
      type,
      modal: Number(/ModalNo:(\d+)/.exec(ls)?.[1] ?? 0),
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

  // Labels name their field's DOM id in key 1.
  const labelFor = new Map<string, string>();
  const labelEl = new Map<string, Element>();
  for (const el of Array.from(
    document.querySelectorAll("[data-ls*=\"Type:'GuiLabel'\"]"),
  )) {
    const forId = /^\{1:'((?:[^'\\]|\\.)*)'/.exec(
      el.getAttribute("data-ls") ?? "",
    )?.[1];
    const t = norm((el as HTMLElement).innerText);
    if (!forId || !t || !visible(el)) continue;
    const k = unesc(forId);
    labelFor.set(k, labelFor.has(k) ? `${labelFor.get(k)} ${t}` : t);
    if (!labelEl.has(k)) labelEl.set(k, el);
  }
  const usedLabels = new Set<string>();

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

  // Window titles.
  titles.set(
    0,
    prop(
      document.getElementById("cuaheader")?.getAttribute("data-ls") ?? "",
      1,
    ) || norm(document.title),
  );
  for (const el of Array.from(
    document.querySelectorAll("[ct='PW'][data-ls]"),
  )) {
    const i = info(el);
    if (!i.modal || !visible(el)) continue;
    const t = norm(
      (document.getElementById(`${el.id}-ttltxt`) as HTMLElement | null)
        ?.innerText,
    );
    if (t && !titles.has(i.modal)) titles.set(i.modal, t);
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
    const { ls, sid, type, modal } = info(el);
    if (!sid || !type) continue;
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
        if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") break;
        if (/\/tbl[^/]+\/[^/]+\[\d+,\d+\]$/.test(sid)) {
          // A table-control cell (the input inside the cell).
          const tbl = el.closest("[data-ls*=\"Type:'GuiTableControl'\"]");
          if (tbl && !inView(el, tbl.getBoundingClientRect())) break;
        }
        const lab = labelFor.get(el.id) ?? "";
        if (lab) usedLabels.add(el.id);
        const ro = fieldLocked(el);
        // A password is never written out, whatever type SAP gives the field.
        const secret =
          type === "GuiPasswordField" ||
          (h as HTMLInputElement).type === "password";
        const val = secret ? (h.value ? "***" : "") : norm(h.value ?? "");
        // A required entry: Web GUI marks the field or its label (aria-required, a --required class); SAP GUI draws a "?" in it.
        const lbl = labelEl.get(el.id);
        const required =
          !ro &&
          (el.getAttribute("aria-required") === "true" ||
            /--required\b|Required\b|urEdf2Req/.test(`${el.closest(".lsField")?.className ?? ""} ${el.className} ${lbl?.className ?? ""} ${lbl?.firstElementChild?.className ?? ""}`));
        out(
          modal,
          `${sid}  field  ${lab || tip} = "${val}"  (${ro ? "read-only" : "edit"})${required ? "  required" : ""}${cursorTold && document.activeElement === el ? "  (cursor here)" : ""}`,
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
        if (t) out(modal, `${sid}  label  ${t}`);
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
        const lab = labelFor.get(el.id) ?? tip;
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
        out(
          modal,
          `${sid}  button  ${name}${t && tip && !tip.startsWith(t) ? `  (${tip})` : ""}${overflow ? '  (behind ">>")' : ""}`,
        );
        break;
      }
      case "GuiTab": {
        const t = prop(ls, 2) || norm(h.innerText);
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
        const v =
          (h as HTMLInputElement).type === "password"
            ? "***"
            : norm((h as HTMLTextAreaElement).value ?? h.innerText).slice(
                0,
                2000,
              );
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
          if (
            td.querySelector("input,[data-ls*='GuiCheckBox']") ||
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
      case "GuiSearchHelpResult": {
        handled.push(el);
        const colIds = (/ColumnI[dD]s:\[([^\]]*)\]/.exec(ls)?.[1] ?? "")
          .split(",")
          .filter(Boolean)
          .map((x) => unesc(x.replace(/^'|'$/g, "")));
        const m = matrix(el);
        const colIdx = [
          ...new Set(m.rows.flatMap(([, r]) => [...r.cells.keys()])),
        ].sort((a, b) => a - b);
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
        out(
          modal,
          `${sid}  grid  ${total} rows${m.selectable ? "; rows can be selected" : ""}; columns: ${names.join(" | ")}`,
        );
        for (const [r, row] of shown.slice(0, limits.grid))
          out(
            modal,
            `  row ${r - 1}${row.selector && selectorOn(row.selector) ? " (selected)" : ""}: ${colIdx.map((c) => (row.cells.get(c) ? cellText(row.cells.get(c)!) : "")).join(" | ")}`,
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
          nodes.push(`  ${"  ".repeat(depth)}${state}${text}  {node ${key}}`);
        }
        out(
          modal,
          `${sid}  tree  ${nodes.length} nodes shown${(() => {
            // A tree longer than its frame: the scrollbar counts its lines.
            const sc = scrollInfo(el.id);
            return !Number.isNaN(sc.total) && sc.total > nodes.length
              ? ` of ${sc.total} (first ${sc.first}; scroll for the others)`
              : "";
          })()}${heads.length ? `; columns: ${heads.join(" | ")}` : ""}`,
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
        const t = prop(ls, 8);
        if (t) out(modal, `${sid}  tab  ${t}`);
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
    if (names.length) out(0, `wnd[0]/mbar  menubar  ${names.join(", ")}`);
    break;
  }
  // Open popup menus: rows whose DOM id is the scripting id.
  // A closed menu stays in the page, moved far above the window (top -9999 px): only rows in the window are open.
  for (const tr of Array.from(document.querySelectorAll("tr[ct^='POMN']"))) {
    if (!visible(tr) || !inView(tr) || tr.id.startsWith("sysInfoArea")) continue;
    out(0, `${tr.id}  menu  ${norm((tr as HTMLElement).innerText)}`);
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
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("div[ct='PW']"))) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.offsetWidth === 0) continue;
    // An SAP popup window holds controls with scripting ids; those are read by extractLook.
    if (el.querySelector("[lsdata*='wnd[']")) continue;
    const title = clean(el.querySelector(".urPWTitleText")?.textContent);
    const body = el.querySelector<HTMLElement>(".urPWContent");
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
  return max;
}

/**
 * Is the menu row with this DOM id open on screen? A row of a popup menu (a
 * context menu, a dropdown button's menu, the ">>" menu of a toolbar). A
 * closed menu stays in the page far above the window.
 */
export function menuRowOpen(rowId: string): boolean {
  const tr = document.getElementById(rowId);
  if (!tr || tr.tagName !== "TR" || !(tr.getAttribute("ct") ?? "").startsWith("POMN")) return false;
  const r = tr.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
}

/**
 * What is open above the screen and closes with Escape alone: "menu" for a
 * popup menu (a context menu, a dropdown button's menu, the ">>" menu of a
 * toolbar, the menu bar's menu), "list" for the list of a dropdown or of a
 * field's earlier entries; "" when nothing is. Web GUI keeps Escape for
 * these and sends SAP nothing (measured on ECC: the menu or list closed, no
 * request). A closed menu stays in the page far above the window.
 */
export function openOverlay(): "menu" | "list" | "" {
  const open = (e: Element): boolean => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility === "visible";
  };
  if (Array.from(document.querySelectorAll("tr[ct^='POMN']")).some((tr) => !tr.id.startsWith("sysInfoArea") && open(tr))) return "menu";
  if (Array.from(document.querySelectorAll("[role='listbox'],.lsListbox,[ct='LIB']")).some(open)) return "list";
  return "";
}

/** Runs in an HTML viewer's frame: its form controls and links, numbered. */
export function extractViewer(start: number): {
  lines: string[];
  next: number;
} {
  const norm = (s: string | null | undefined) =>
    (s ?? "").replace(/[\s\u00a0]+/g, " ").replace(/^ | $/g, "");
  const out: string[] = [];
  let n = start;
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
  return { lines: out, next: n };
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
    if (typeof v === "string")
      return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    if (Array.isArray(v)) return `[${v.map(lit).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${k}:${lit(x)}`)
        .join(",")}}`;
    return String(v);
  };
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
  /** A toolbar button behind the toolbar's ">>" button: the DOM id of that ">>" button; "" otherwise. */
  overflow: string;
  /** The button's DOM id ("" when not a button): its entry in the ">>" menu is "<id>-BtnMenu". */
  dom: string;
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
      modal: Number(/ModalNo:(\d+)/.exec(ls)?.[1] ?? 0),
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
    return document.getElementById(`${bar.id}-hiddenOpener`);
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
  if (!hits.length && want.startsWith("wnd["))
    want = want.slice(want.lastIndexOf("/") + 1);
  if (!hits.length) hits = pick(all.filter((x) => x.sid.endsWith(`/${want}`)));
  if (!hits.length) {
    // A field's SAP name (VBAK-AUART): the id's last segment without its type prefix.
    hits = pick(
      all.filter(
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
  const h = hits[0]!;
  h.el.setAttribute("data-sap-act", "1");
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
    readonly: ro(h.el),
    tag: h.el.tagName,
    inputType:
      h.el.tagName === "INPUT" ? (h.el as HTMLInputElement).type || "text" : "",
    overflow: opener && !visible(h.el) ? opener.id : "",
    dom: h.el.id,
  };
}

/** A row of a smart table (grid, tree, value-help list) and one of its cells, marked for Playwright. */
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
      "[data-ls*=\"Type:'GuiGridView'\"],[data-ls*=\"Type:'GuiTree'\"],[data-ls*=\"Type:'GuiSearchHelpResult'\"]",
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
  if (a.col !== undefined && a.col !== "") {
    const ths = Array.from(root.querySelectorAll("th[lsmatrixcolindex]"));
    const ls = root.getAttribute("data-ls") ?? "";
    const ids = (/ColumnI[dD]s:\[([^\]]*)\]/.exec(ls)?.[1] ?? "")
      .split(",")
      .map((x) => x.replace(/^'|'$/g, ""));
    const col = String(a.col);
    const th =
      ths.find((t) => sidOf(t).endsWith(`/col${col}`)) ??
      ths.find((t) =>
        (t.getAttribute("title") ?? (t as HTMLElement).innerText)
          .replace(/\s+/g, " ")
          .includes(col),
      );
    let ci = th ? Number(th.getAttribute("lsmatrixcolindex")) : NaN;
    if (Number.isNaN(ci) && ids.indexOf(col) >= 0) ci = ids.indexOf(col) + 1;
    if (Number.isNaN(ci) && /^\d+$/.test(col)) ci = Number(col) + 1;
    cell = inRow.find(
      (td) => Number(td.getAttribute("lsmatrixcolindex")) === ci,
    );
  }
  const hicCell = inRow.find((td) => td.getAttribute("subct") === "HIC");
  const isTree = /Type:'GuiTree'/.test(root.getAttribute("data-ls") ?? "");
  // A tree node is opened on its text (in the hierarchy cell); a grid row on its first filled cell.
  if (!cell && isTree && hicCell)
    cell = hicCell.querySelector("[ct='TV']") ?? hicCell;
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
      "[data-ls*=\"Type:'GuiGridView'\"],[data-ls*=\"Type:'GuiTableControl'\"],[data-ls*=\"Type:'GuiSearchHelpResult'\"]",
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
  const add = (sid: string, text: string, key: string) => {
    if (!sid || !text || seen.has(sid)) return;
    seen.add(sid);
    out.push({ sid, text, key });
  };
  for (const x of Array.from(document.querySelectorAll(".lsMnu--root xmp"))) {
    const src = x.textContent ?? "";
    // ECC: lsdata="{1:'Create',15:'F8',18:{ModalNo:0,SID:'wnd[0]/mbar/menu[0]/menu[3]',Type:'GuiMenu'}}"
    for (const m of execAll(src, /lsdata="(\{1:'[^"]*)"/g)) {
      const ls = m[1] ?? "";
      const sid = /SID:'((?:[^'\\\\]|\\\\.)*)'/.exec(ls)?.[1] ?? "";
      add(sid.replace(/\\\\/g, "\\"), prop(ls, 1), prop(ls, 15));
    }
    // S/4HANA 2025 writes the template's lsdata as JSON in single quotes.
    for (const m of execAll(src, /lsdata='(\{[^']*\})'/g)) {
      try {
        const o = JSON.parse(m[1] ?? "") as Record<string, unknown>;
        const sidObj = Object.values(o).find((v) => v && typeof v === "object" && "SID" in (v as object)) as { SID?: string } | undefined;
        if (sidObj?.SID && typeof o["1"] === "string") add(sidObj.SID, o["1"], typeof o["15"] === "string" ? o["15"] : "");
      } catch {
        /* not JSON */
      }
    }
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
    // A row of an open menu: its DOM id is its scripting id.
    if (el.tagName === "TR" && (el.getAttribute("ct") ?? "").startsWith("POMN")) return { sid: el.id, type: "GuiMenu", pressable: true, text: norm((el as HTMLElement).innerText) };
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
  const KINDS = /Type:'(GuiTableControl|GuiGridView|GuiTree|GuiSearchHelpResult|ABAPLIST)'/;
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
  const visible = num(3);
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
