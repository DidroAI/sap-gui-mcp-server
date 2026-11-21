/**
 * The UI5 control-tree reader for Fiori screens. Four functions that run
 * inside the page (Playwright serialises them with toString()), in every
 * frame where SAPUI5 is loaded:
 *
 * - `ui5Look({ compact })`: the screen as text. Every visible control in
 *   reading order with its type, id, texts, value, state and bindings. The
 *   full view keeps every control and every id; the compact view drops
 *   layout-only controls, cuts ids to their shortest unique tail, puts a
 *   field's label on the field's line, writes table rows as one line each
 *   and says what a link or a row does.
 * - `ui5Control(request)`: resolves an id of the view (full id, or the
 *   compact tail) and either describes the control (for the risk rule), marks
 *   the DOM element the driver then clicks or types into with real input
 *   events, or does what only the control's API can do (dropdown entry,
 *   scrolling).
 * - `ui5Idle(options)`: resolves when UI5 is idle.
 * - `ui5Info()`: what the page knows about itself (user, system, client, app).
 *
 * Each function must stay self-contained: no imports, no outer variables.
 */

// In-page UI5 globals and controls are untyped.
// biome-ignore lint/suspicious/noExplicitAny: UI5 controls
type C = any;

/** Attribute the driver's locator finds the action target by. */
export const TARGET_ATTR = "data-sap-mcp-target";

export interface Ui5LookOptions {
  compact: boolean;
  /** Only this control and what is inside it (an id of the view), whole: also the part below the fold. */
  id?: string;
}

export function ui5Look(opts: Ui5LookOptions): string {
  const w = window as C;
  const sap = w.sap;
  if (!sap?.ui?.getCore) return "";
  const El = sap.ui.require?.("sap/ui/core/Element") ?? sap.ui.core?.Element;
  const byId = (id: string): C => (El?.getElementById ? El.getElementById(id) : sap.ui.getCore().byId(id));
  const norm = (s: unknown) =>
    String(s ?? "")
      .replace(/[\s ]+/g, " ")
      .replace(/^ +| +$/g, "");
  const W = innerWidth;
  const H = innerHeight;
  // One control, whole: what is rendered counts, in the viewport or not.
  const whole = !!opts.id;
  const visible = (el: Element | null) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    // Some containers have zero width while their content shows (NumericContent in OVP cards).
    if (!(r.width > 0 || r.height > 0) || (!whole && !(r.bottom > 0 && r.right > 0 && r.top < H && r.left < W))) return false;
    return (el as C).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false;
  };
  const typeName = (c: C): string => c.getMetadata().getName();
  const isA = (c: C, t: string) => {
    try {
      return !!c?.isA?.(t);
    } catch {
      return false;
    }
  };
  const short = (t: string) =>
    t
      .replace(
        /^sap\.(m|f|ui\.core|ui\.layout\.form|ui\.layout|uxap|ui\.comp|ui\.mdc|ui\.table|ui\.unified|suite\.ui\.commons|suite\.ui\.microchart|ushell\.gen\.ui5\.webcomponents(?:-fiori)?\.dist|ushell\.ui\.launchpad|ushell\.ui\.shell|ushell\.ui|viz\.ui5\.controls|fe\.macros|fe\.core)\./,
        "",
      )
      .replace(/^sap\./, "");

  const TEXT_PROPS = [
    "title",
    "text",
    "heading",
    "header",
    "subheader",
    "subtitle",
    "intro",
    "description",
    "label",
    "number",
    "numberUnit",
    "unit",
    "info",
    "counter",
    "footer",
    "objectTitle",
    "objectSubtitle",
    "value",
    "placeholder",
    "tooltip",
    "highlightText",
    "scale",
    "indicator",
    "count",
    "messageType",
    "highlight",
    "vizType",
  ];
  const props = (c: C): Record<string, unknown> => {
    const all = c.getMetadata().getAllProperties();
    const o: Record<string, unknown> = {};
    for (const p of TEXT_PROPS) {
      if (!all[p] && p !== "tooltip") continue;
      let v: unknown;
      try {
        v = p === "tooltip" ? c.getTooltip_AsString?.() : c.getProperty(p);
      } catch {
        continue;
      }
      if (v === "None" || v === "Inherit") continue;
      if (typeof v === "string" ? norm(v) !== "" : typeof v === "number" && p !== "value" ? false : v != null && v !== "" && typeof v !== "object")
        o[p] = typeof v === "string" ? norm(v) : v;
    }
    // A password is never written out: by the control's type, or by the input element it renders.
    if (o.value !== undefined) {
      let secret = false;
      try {
        secret = (!!all.type && c.getProperty("type") === "Password") || !!(c.getDomRef?.() as Element | null)?.querySelector?.("input[type='password']") || (c.getFocusDomRef?.() as HTMLInputElement | null)?.type === "password";
      } catch {
        secret = true;
      }
      if (secret) o.value = "***";
    }
    // An empty Text with an empty indicator shows "–" on screen.
    if (o.text === undefined && all.text && c.getEmptyIndicatorMode?.() && c.getEmptyIndicatorMode() !== "Off" && !norm(c.getText?.())) o.text = "–";
    return o;
  };

  // ---- labels: field id -> label text (Label.labelFor, form elements, ariaLabelledBy)
  const labelOf = new Map<string, string>();
  const labelIds = new Set<string>();
  const reg = El?.registry ?? sap.ui.getCore().mElements;
  const allControls: C[] = reg?.all ? Object.values(reg.all()) : Object.values(reg ?? {});
  for (const c of allControls) {
    try {
      if (isA(c, "sap.m.Label") || isA(c, "sap.ui.comp.smartfield.SmartLabel")) {
        const f = c.getLabelFor?.();
        if (f && norm(c.getText())) {
          labelOf.set(f, norm(c.getText()));
          labelIds.add(c.getId());
        }
      }
      if (isA(c, "sap.ui.layout.form.FormElement") || isA(c, "sap.ui.comp.smartform.GroupElement")) {
        const lab = c.getLabelControl?.() ?? null;
        const txt = norm(c.getLabelText?.() ?? lab?.getText?.() ?? "");
        if (txt) {
          for (const f of c.getFields?.() ?? c.getElements?.() ?? []) if (!labelOf.has(f.getId())) labelOf.set(f.getId(), txt);
          if (lab) labelIds.add(lab.getId());
        }
      }
    } catch {
      /* a control that cannot answer is skipped */
    }
  }
  const labelFor = (c: C): string => {
    let l = labelOf.get(c.getId());
    // SmartField / mdc Field: the label points at the wrapper, the input is inside.
    for (let p = c.getParent?.(), i = 0; !l && p && i < 3; p = p.getParent?.(), i++) l = labelOf.get(p.getId?.());
    if (!l) {
      const ids: string[] = c.getAriaLabelledBy?.() ?? [];
      const t = ids.map((id) => byId(id)?.getText?.()).filter(Boolean);
      if (t.length) l = norm(t.join(" "));
    }
    if (!l && (isA(c, "sap.m.InputBase") || isA(c, "sap.m.CheckBox") || isA(c, "sap.m.Switch") || isA(c, "sap.m.Select") || isA(c, "sap.m.DynamicDateRange"))) {
      // Last resort: a Label placed right before the field (or its wrapper) in the same container.
      for (let x = c, i = 0; x && i < 3; x = x.getParent?.(), i++) {
        const p = x.getParent?.();
        const agg = x.sParentAggregationName;
        const sibs: C[] = p && agg ? [].concat(p.getAggregation?.(agg) ?? []) : [];
        const k = sibs.indexOf(x);
        if (k > 0 && isA(sibs[k - 1], "sap.m.Label") && !sibs[k - 1].getLabelFor?.()) {
          labelIds.add(sibs[k - 1].getId());
          return norm(sibs[k - 1].getText()).replace(/:$/, "");
        }
      }
    }
    return l ?? "";
  };

  // ---- state of a control as words the model reads
  const state = (c: C): string[] => {
    const s: string[] = [];
    const g = (n: string) => {
      try {
        return c.getMetadata().getAllProperties()[n] ? c.getProperty(n) : undefined;
      } catch {
        return undefined;
      }
    };
    if (isA(c, "sap.m.CheckBox") || isA(c, "sap.m.RadioButton")) s.push(c.getSelected() ? "[x] checked" : "[ ] unchecked");
    else if (isA(c, "sap.m.Switch")) s.push(c.getState() ? "[x] on" : "[ ] off");
    else if (isA(c, "sap.m.ToggleButton")) s.push(c.getPressed() ? "(pressed)" : "(not pressed)");
    else if (isA(c, "sap.m.ListItemBase") && c.getParent?.()?.getMode?.() && /Select|Multi/.test(c.getParent().getMode()) && c.getSelected()) s.push("(selected)");
    if (isA(c, "sap.m.Select")) {
      const it = c.getSelectedItem?.();
      if (it) s.push(`= "${norm(it.getText())}"`);
    }
    if (isA(c, "sap.m.IconTabFilter")) {
      const bar = c.getParent?.()?.getParent?.();
      const key = bar?.getSelectedKey?.() ?? c.getParent?.()?.getSelectedKey?.();
      if (key && (c.getKey?.() || c.getId()) === key) s.push("(selected)");
    }
    if (isA(c, "sap.m.SegmentedButtonItem")) {
      const p = c.getParent?.();
      if (p?.getSelectedKey?.() && p.getSelectedKey() === c.getKey?.()) s.push("(selected)");
    }
    if (isA(c, "sap.uxap.ObjectPageSection")) {
      const opl = c.getParent?.();
      if (opl?.getSelectedSection?.() === c.getId()) s.push("(selected)");
    }
    if (g("enabled") === false) s.push("(disabled)");
    if (g("editable") === false && (isA(c, "sap.m.InputBase") || isA(c, "sap.m.Select") || isA(c, "sap.m.CheckBox"))) s.push("(read-only)");
    if (g("required") === true) s.push("(required)");
    const vs = g("valueState");
    if (vs && vs !== "None") s.push(`(${String(vs).toLowerCase()}${norm(g("valueStateText")) ? `: ${norm(g("valueStateText"))}` : ""})`);
    if (g("selected") === true && !s.some((x) => /checked|selected/.test(x))) s.push("(selected)");
    return s;
  };

  const binding = (c: C): string => {
    const parts: string[] = [];
    try {
      for (const p of ["value", "text", "selected", "state", "selectedKey", "title", "number"]) {
        const bi = c.getBindingInfo?.(p);
        const path = bi?.parts?.[0]?.path ?? bi?.path;
        if (path && !String(bi.parts?.[0]?.model ?? "").startsWith("$") && !String(path).startsWith("/conditions"))
          parts.push(`${p}:${bi.parts?.[0]?.model ? `${bi.parts[0].model}>` : ""}${path}`);
      }
      const ctx = c.getBindingContext?.()?.getPath?.();
      if (ctx) parts.push(`ctx:${ctx}`);
    } catch {
      /* bindings are optional */
    }
    return parts.join(" ");
  };

  const interactiveTypes = ["press", "change", "liveChange", "select", "selectionChange", "itemPress", "valueHelpRequest", "search", "navigate", "detailPress"];
  const interactive = (c: C) => {
    const ev = c.getMetadata().getAllEvents?.() ?? {};
    return interactiveTypes.some((e) => ev[e]) || isA(c, "sap.m.InputBase") || isA(c, "sap.m.ListItemBase");
  };

  // ---- walk the visible controls in document order
  let doms = Array.from(document.querySelectorAll("[data-sap-ui]"));
  if (opts.id) {
    const h = opts.id.replace(/^#/, "").replace(/^id=/, "");
    let root: C = allControls.find((x) => x.getId() === h);
    if (!root) {
      const hits = allControls.filter((x) => {
        const id: string = x.getId();
        return id.endsWith(`--${h}`) || id.endsWith(`::${h}`);
      });
      root = hits.find((x) => x.getDomRef?.()?.getBoundingClientRect?.().width > 0) ?? hits[0];
    }
    const rd: Element | null = root?.getDomRef?.() ?? null;
    if (!rd) return "";
    doms = [rd, ...Array.from(rd.querySelectorAll("[data-sap-ui]"))];
  }
  const shown = new Map<Element, number>(); // emitted DOM element -> depth
  const shownField = new Set<Element>();
  const lines: string[] = [];
  // Compact id: the shortest tail of the id (cut at "--" or "::") that no other control's id ends with.
  const tailCount = new Map<string, number>();
  const tails = (id: string): string[] => {
    const parts = id.split(/(--|::)/);
    const out: string[] = [];
    for (let k = parts.length - 1; k >= 2; k -= 2) out.push(parts.slice(k).join(""));
    return out;
  };
  if (opts.compact) for (const c of allControls) for (const t of tails(c.getId?.() ?? "")) tailCount.set(t, (tailCount.get(t) ?? 0) + 1);
  const handleOf = (id: string) => {
    if (!opts.compact) return id;
    for (const t of tails(id)) if (tailCount.get(t) === 1) return t;
    return id;
  };
  /** Text a person sees in an element: no screen-reader-only text, no icon glyphs. */
  const shownText = (d: Element): string => {
    const out: string[] = [];
    const tw = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(".sapUiInvisibleText, .sapUiPseudoInvisibleText, .sapUiHidden") || !(p as HTMLElement).offsetWidth) continue;
      const t = norm(n.nodeValue).replace(/[-]/g, "");
      if (t) out.push(t);
    }
    return norm(out.join(" "));
  };
  // Only table rows are written as one line; other list items (cards, business partners) keep their children.
  const insideRow = (el: Element) => !!el.parentElement?.closest(".sapMListTblRow, .sapUiTableTr, .sapUiTableRow");
  const rowLine = (c: C): string | null => {
    // A table row: its cells' shown text, in column order.
    let cells: C[] = [];
    if (isA(c, "sap.m.ColumnListItem")) cells = c.getCells?.() ?? [];
    else if (isA(c, "sap.ui.table.Row")) cells = c.getCells?.() ?? [];
    else return null;
    const txt = cells.map((x: C) => {
      const d = x?.getDomRef?.();
      if (!d) return "";
      const inp = d.matches?.("input") ? d : d.querySelector?.("input");
      if (inp && (inp as HTMLInputElement).type === "password") return (inp as HTMLInputElement).value ? "***" : "";
      return inp ? norm((inp as HTMLInputElement).value) : shownText(d);
    });
    if (txt.every((t) => !t)) return null;
    return txt.join(" | ");
  };
  /**
   * Is this grid-table row selected? A table with a selection plugin (every
   * Fiori elements V4 grid table, value help tables) answers through the
   * plugin: its own getSelectedIndices() and isIndexSelected() throw then.
   */
  const gridRowSelected = (tbl: C, row: C): boolean | undefined => {
    try {
      const plugin = [...(tbl?.getDependents?.() ?? []), ...(tbl?.getPlugins?.() ?? [])].find((p: C) => isA(p, "sap.ui.table.plugins.SelectionPlugin"));
      if (plugin) return plugin.isSelected ? !!plugin.isSelected(row) : !!plugin.isIndexSelected?.(row.getIndex?.());
      if (!tbl?.getSelectionMode?.() || tbl.getSelectionMode() === "None") return undefined;
      return !!tbl.isIndexSelected?.(row.getIndex?.());
    } catch {
      return undefined;
    }
  };
  const tableHead = (c: C): string => {
    try {
      if (isA(c, "sap.m.Table")) {
        const cols = (c.getColumns?.() ?? []).filter((x: C) => x.getVisible?.() !== false);
        return cols.map((x: C) => norm(x.getHeader?.()?.getText?.() ?? x.getHeader?.()?.getDomRef?.()?.innerText ?? "")).join(" | ");
      }
      if (isA(c, "sap.ui.table.Table")) {
        const cols = (c.getColumns?.() ?? []).filter((x: C) => x.getVisible?.() !== false);
        return cols.map((x: C) => norm(x.getLabel?.()?.getText?.() ?? x.getMultiLabels?.()?.[0]?.getText?.() ?? "")).join(" | ");
      }
    } catch {
      /* no header */
    }
    return "";
  };
  /** A table greyed out because the filter bar changed and Go was not pressed: its rows are the old ones. */
  const staleTable = (c: C, el: Element): boolean => {
    try {
      for (let p = c, i = 0; p && i < 4; p = p.getParent?.(), i++) if (p.getShowOverlay?.() === true || p._oTable?.getShowOverlay?.() === true) return true;
      const over = (el.closest(".sapUiMdcTable, .sapUiCompSmartTable") ?? el).querySelector(".sapUiOverlay, .sapUiTableOverlayArea, .sapUiMdcTableOverlay");
      return !!over && visible(over);
    } catch {
      return false;
    }
  };
  const chartData = (c: C): string => {
    if (!/viz\.ui5\.controls\.VizFrame$|sap\.chart\.Chart$/.test(typeName(c))) return "";
    try {
      const b = c.getBinding?.("data") ?? c.getDataset?.()?.getBinding?.("data");
      // Only the contexts the chart already holds: getContexts() would start a new request.
      const ctxs: C[] = b?.getCurrentContexts?.() ?? [];
      const rows = ctxs
        .slice(0, 30)
        .map((x: C) => {
          const o = x?.getObject?.() ?? {};
          return Object.entries(o)
            .filter(([k, v]) => !k.startsWith("@") && !k.startsWith("__") && v != null && typeof v !== "object")
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
        })
        .filter(Boolean);
      const d = c.getDomRef?.();
      const painted = d
        ? [
            ...new Set(
              Array.from(d.querySelectorAll("svg text"))
                .map((t) => norm((t as Element).textContent))
                .filter(Boolean),
            ),
          ]
        : [];
      const lab = painted.length ? ` | labels: ${painted.join(" | ")}` : "";
      return rows.length ? `${rows.length} points: ${rows.join(" ; ")}${lab}` : lab;
    } catch {
      return "";
    }
  };
  const isPopup = (c: C) =>
    isA(c, "sap.m.Dialog") ||
    isA(c, "sap.m.Popover") ||
    isA(c, "sap.m.ResponsivePopover") ||
    isA(c, "sap.m.MessagePopover") ||
    isA(c, "sap.m.MessageBox") ||
    isA(c, "sap.m.ActionSheet") ||
    (isA(c, "sap.m.SelectList") && !!c.getDomRef?.()?.closest?.(".sapMPopover"));
  const LAYOUT =
    /^(sap\.m\.(FlexBox|HBox|VBox|ScrollContainer|Page|App|NavContainer|Shell|Bar|Toolbar|OverflowToolbar|ToolbarSpacer|ToolbarSeparator|Panel|IconTabHeader|SplitContainer|SplitApp|FlexibleColumnLayout|Wizard|Image|BusyIndicator|HeaderContainer|Column|Avatar|CustomListItem)|sap\.ui\.core\.(mvc\.\w+View|ComponentContainer|UIComponent|Icon|InvisibleText|HTML|Fragment)|sap\.ui\.layout\..*|sap\.f\.(DynamicPage|DynamicPageHeader|GridContainer|FlexibleColumnLayout|ShellBar)|sap\.uxap\.(ObjectPageLayout|ObjectPageHeaderContent|AnchorBar|BlockBase|.*Block)|sap\.ui\.comp\.smartform\.(Group|Layout|SmartForm)|sap\.ui\.comp\.variants\..*|sap\.ushell\.ui\.launchpad\.(Page|Section|VizInstance.*|TileContainer)|sap\.ui\.table\.(Column|RowAction|RowActionItem)|sap\.ui\.mdc\.(Field|FilterField|table\.Column|table\.\w+TableType)|sap\.fe\.core\.controls\..*|sap\.fe\.macros\.controls\.FieldWrapper)$/;

  let lastContext = "";
  /** Tables whose first row already says what a press on a row does. */
  const hinted = new Set<unknown>();
  /** One control's line. A control that throws while it is read costs its own line only, never the view. */
  const readControl = (el: Element): void => {
      if (!visible(el)) return;
      const c = byId(el.id);
      if (!c) return;
      const t = typeName(c);
      // The launchpad's shell bar is a web component: its search, notification and other buttons are drawn
      // inside it, not as controls. They get a line each, under an id of their own ("shellbar:<name>").
      if (/webcomponents.*\.ShellBar$/.test(t) && (el as C).shadowRoot) {
        for (const b of Array.from((el as C).shadowRoot.querySelectorAll("[data-ui5-stable].ui5-shellbar-button")) as Element[]) {
          const name = b.getAttribute("data-ui5-stable") ?? "";
          // The profile button is the avatar's line; a custom item has a generated name, so its text names it.
          if (!name || name === "profile" || !(b.getBoundingClientRect().width > 0)) continue;
          const tip = norm(b.getAttribute("tooltip") ?? b.getAttribute("accessible-name") ?? b.getAttribute("title") ?? "");
          lines.push(`${opts.compact ? "ShellBarButton #" : "sap.ushell.ShellBarButton id="}shellbar:${/-stable-dom-ref$/.test(name) ? tip.toLowerCase().replace(/[^a-z0-9]+/g, "-") : name}${opts.compact ? ` "${tip}"` : ` text="${tip}"`}`);
        }
      }
      // depth: the nearest emitted ancestor
      let depth = 0;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const d = shown.get(p);
        if (d !== undefined) {
          depth = d + 1;
          break;
        }
      }
      const pr = props(c);
      const st = state(c);
      // A link in a table row: its column is on the table's line, in order.
    const lab = opts.compact && isA(c, "sap.m.Link") && insideRow(el) ? "" : labelFor(c);
      const hasContent = Object.keys(pr).length > 0 || st.length > 0;
      const popup = isPopup(c);
      const row = rowLine(c);
      const isTable = isA(c, "sap.m.Table") || isA(c, "sap.ui.table.Table") || isA(c, "sap.m.List");
      const inter = interactive(c);
      if (opts.compact) {
        // Inside a table row only inputs and states carry what the row line does not.
        if (
          insideRow(el) &&
          !row &&
          !(isA(c, "sap.m.InputBase") && c.getEditable?.() !== false) &&
          !isA(c, "sap.m.CheckBox") &&
          !isA(c, "sap.m.Switch") &&
          !isA(c, "sap.m.Button") &&
          !isA(c, "sap.m.Link")
        )
          return;
        if (labelIds.has(c.getId())) return; // printed on its field's line
        if (/-(selectMulti|selectSingle|imgNav|imgDel)$/.test(c.getId())) return; // part of the row line
      // A launchpad tile is one line: the tile's, with its header and subheader. Not its wrapper, not its texts again.
      if (/VizInstance/.test(t) && el.querySelector(".sapMGT")) return;
      if (isA(c, "sap.m.Text")) {
        let tile: C = c.getParent?.();
        for (let i = 0; tile && i < 3 && !isA(tile, "sap.m.GenericTile"); i++) tile = tile.getParent?.();
        if (tile && isA(tile, "sap.m.GenericTile") && [norm(tile.getHeader?.()), norm(tile.getSubheader?.())].includes(norm(c.getText?.()))) return;
      }
      // The one button a menu button renders is the menu button again.
      if (/-internalBtn$/.test(c.getId()) && isA(c.getParent?.(), "sap.m.MenuButton") && (pr.text || pr.tooltip || c.getParent().getTooltip_AsString?.())) return;
        // Column headers are on the table's line already.
        if (el.closest("th, .sapMListTblHeaderCell, .sapUiTableColHdrCnt") && !isA(c, "sap.m.CheckBox") && !isA(c, "sap.m.Button")) return;
        const field = isA(c, "sap.m.InputBase") || isA(c, "sap.m.Select") || isA(c, "sap.m.CheckBox") || isA(c, "sap.m.Switch") || isA(c, "sap.m.DynamicDateRange");
        // A field inside a field (DynamicDateRange's input, a SmartField's inner input) is the same field.
        if (field) {
          let outer = false;
          for (let p = el.parentElement; p && !outer; p = p.parentElement) if (shownField.has(p)) outer = true;
          if (outer) return;
          shownField.add(el);
        }
        const layoutOnly = !field && LAYOUT.test(t) && !popup && !isTable && !Object.keys(pr).some((k) => k === "title" || k === "text" || k === "heading");
        if (layoutOnly || (!field && !hasContent && !popup && !isTable && !row && !lab && !(inter && (pr.tooltip || c.getIcon?.())))) return;
      }
      shown.set(el, depth);
      const h = handleOf(c.getId());
      const bits: string[] = [];
      bits.push(opts.compact ? short(t) : t);
      bits.push(opts.compact ? `#${h}` : `id=${c.getId()}`);
      if (lab) bits.push(`"${lab}":`);
      const shownProps = { ...pr };
      // A tooltip that repeats the text ("Open details for X") or is a long description adds nothing.
      if (opts.compact && shownProps.tooltip) {
        const tip = String(shownProps.tooltip);
        const others = Object.entries(shownProps)
          .filter(([k]) => k !== "tooltip")
          .map(([, v]) => String(v));
        if (others.some((v) => v && tip.includes(v)) || (others.length > 0 && tip.length > 60)) delete shownProps.tooltip;
      }
      // A field whose value is not a text property (a date range): what its input shows.
      if (shownProps.value === undefined && isA(c, "sap.m.DynamicDateRange")) {
        const inp = el.querySelector("input") as HTMLInputElement | null;
        if (inp && inp.type !== "password" && norm(inp.value)) shownProps.value = norm(inp.value);
      }
      for (const [k, v] of Object.entries(shownProps)) {
        if (opts.compact && (k === "text" || k === "title" || k === "value" || k === "heading")) bits.push(`"${v}"`);
        else bits.push(`${k}="${v}"`);
      }
      if (opts.compact && !pr.text && !pr.title && !pr.tooltip && typeof c.getIcon?.() === "string" && c.getIcon() && inter)
        bits.push(`icon=${String(c.getIcon()).replace("sap-icon://", "")}`);
      bits.push(...st);
      // Tokens a field holds but does not show (folded behind "1 more"): the shown ones have lines of their own.
      if (typeof c.getTokens === "function" && isA(c, "sap.m.MultiInput")) {
        const hiddenTokens = (c.getTokens() as C[]).filter((t) => !visible(t.getDomRef?.())).map((t) => `"${norm(t.getText?.())}"`);
        if (hiddenTokens.length) bits.push(`(and ${hiddenTokens.length} token${hiddenTokens.length > 1 ? "s" : ""} not shown: ${hiddenTokens.slice(0, 20).join(", ")}${hiddenTokens.length > 20 ? ", ..." : ""})`);
      }
      // What a link does: real links name their target, a link with a popup says so. A link inside a row
      // has its own action (a quick view, in F1873), not the row's: the table's first row says that once.
      if (opts.compact && (isA(c, "sap.m.Link") || isA(c, "sap.m.ObjectIdentifier"))) {
        const href = isA(c, "sap.m.Link") ? String(c.getHref?.() ?? "") : "";
        const pop = c.getAriaHasPopup?.();
        if (href && href !== "#") bits.push(`(goes to ${href.slice(0, 80)})`);
        else if (pop && pop !== "None") bits.push("(opens a popup)");
      }
      if (isTable) {
        const head = tableHead(c);
        const n = c.getBinding?.("items")?.getLength?.() ?? c.getBinding?.("rows")?.getLength?.();
        if (head) bits.push(`columns: ${head}`);
        if (n != null) bits.push(`(${n} rows)`);
        if (staleTable(c, el)) bits.push("(STALE: the filters changed after these rows were read; press Go to read them again)");
      }
      // Charts: the data points behind the bars (the SVG only carries axis labels).
      const data = chartData(c);
      if (data) bits.push(`data: ${data}`);
      if (row) {
        const tbl = c.getParent?.();
        // A grid-table row is selected through its table.
        const grid = isA(c, "sap.ui.table.Row") ? gridRowSelected(tbl, c) : undefined;
        const picked = c.getSelected?.() ?? grid;
        const sel = picked ? "[x] " : grid === false || tbl?.getMode?.()?.includes?.("Multi") ? "[ ] " : "";
        // What a press on a row does, said on the first such row of each table.
      let hint = "";
      if (/Navigation|Active/.test(c.getType?.() ?? "") && !hinted.has(tbl)) {
        hinted.add(tbl);
        hint = "  (press a row to open it; a link in a row has its own action)";
      }
      bits.push(`row: ${sel}${row}${hint}`);
      }
      if (popup) bits.unshift("POPUP");
      const b = binding(c);
      if (b && (!opts.compact || row || isA(c, "sap.m.InputBase") || /ObjectPage/.test(t))) {
      // Compact: the context only, without the key parts every active document shares (no draft id, "active").
      const shownBinding = opts.compact
        ? b
            .replace(/^.*\bctx:/, "ctx:")
            .replace(/,?DraftUUID=(guid')?00000000-0000-0000-0000-000000000000'?/g, "")
            .replace(/,?IsActiveEntity=true/g, "")
            .replace(/\(,/g, "(")
        : b;
      // The fields of one object share its context: said on the first of them, not on each.
      if (!opts.compact || row || shownBinding !== lastContext) bits.push(`{${shownBinding}}`);
      if (opts.compact && !row) lastContext = shownBinding;
    }
      lines.push(`${"  ".repeat(Math.min(depth, opts.compact ? 6 : 40))}${bits.join(" ")}`);
  };
  for (const el of doms) {
    try {
      readControl(el);
    } catch (e) {
      let who = el.id;
      try {
        const c = byId(el.id);
        who = `${opts.compact ? short(typeName(c)) : typeName(c)} ${opts.compact ? `#${handleOf(el.id)}` : `id=${el.id}`}`;
      } catch {
        /* the id alone */
      }
      lines.push(`${who} [not read: ${norm((e as Error)?.message ?? e).slice(0, 120)}]`);
    }
  }
  // Message toasts are plain DOM, not controls.
  for (const t of Array.from(document.querySelectorAll(".sapMMessageToast"))) if (visible(t)) lines.push(`TOAST "${norm((t as HTMLElement).innerText)}"`);
  // SAP's in-app help ("Help Topics", the panel the shell bar's Help button opens beside the page) is plain
  // DOM too. One line: that it is open, how it closes, and its topics, each once.
  for (const panel of Array.from(document.querySelectorAll(".help4-control-carousel"))) {
    if (!visible(panel)) continue;
    const bare = (e: Element | null) => norm((e as HTMLElement | null)?.innerText).replace(/\u2060/g, "");
    const topics: string[] = [];
    for (const tile of Array.from(panel.querySelectorAll(".help4-control-tile"))) {
      const cap = bare(tile.querySelector(".help4-caption"));
      const desc = bare(tile.querySelector(".help4-desc"));
      const topic = desc && desc !== cap ? `${cap}: ${desc.slice(0, 90)}` : cap;
      if (cap && !topics.some((t) => t === topic || t.startsWith(`${cap}:`))) topics.push(topic);
    }
    const shown = topics.slice(0, 12);
    lines.push(
      `PANEL "${bare(panel.querySelector(".help4-head")) || "Help"}" (SAP's help for this page, open beside it; the shell bar's Help button closes it)${shown.length ? `: ${shown.join(" | ")}` : ""}${topics.length > shown.length ? ` | ... ${topics.length - shown.length} more topics` : ""}`,
    );
    break;
  }
  // The view holds what is in the viewport: say when the main area goes on below.
  let best: Element | null = null;
  let area = 0;
  const popups = Array.from(document.querySelectorAll(".sapMDialog, .sapMPopover")).filter((e) => visible(e));
  const scope: ParentNode = popups[popups.length - 1] ?? document;
  for (const e of Array.from(scope.querySelectorAll("*"))) {
    if (e.scrollHeight <= e.clientHeight + 20 || e.clientHeight < 80 || e.clientWidth < 80) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(e).overflowY) || !visible(e)) continue;
    const a = e.clientHeight * e.clientWidth;
    if (a > area) {
      area = a;
      best = e;
    }
  }
  if (best) {
    const top = Math.round(best.scrollTop);
    const end = top + best.clientHeight;
    const more = [top > 10 ? "above" : "", end < best.scrollHeight - 10 ? "below" : ""].filter(Boolean);
    if (more.length) lines.push(`SCROLL shown ${top}-${end} of ${best.scrollHeight} px, more ${more.join(" and ")}: {"do":"scroll","how":"${more.includes("below") ? "down" : "up"}"}`);
  }
  const title = norm(document.title);
  // The launchpad's state keys change on every filter edit and say nothing: left out, so the line stays the same.
  // Two of them can stand side by side (?sap-iapp-state--history=..&sap-iapp-state=..): each is taken out with the "&" after it.
  const hash = location.hash.replace(/(?<=[?&])sap-[ix]app-state(--history)?=[^&/]*&?/g, "").replace(/[?&]$/, "");
  return `PAGE ${title} (${hash.slice(0, 120)})\n${lines.join("\n")}`;
}

/** What the risk rule needs to know about a control (see risk.ts). */
export interface ControlFacts {
  /** UI5 class, e.g. "sap.m.Button". */
  type: string;
  /** Full UI5 id. */
  id: string;
  /** Text, title or, failing those, the tooltip. */
  text: string;
  icon?: string;
  /** sap.m.ButtonType of a button: Emphasized, Accept, Reject, Default, Transparent, ... */
  buttonType?: string;
  href?: string;
  enabled?: boolean;
  /** Inside the footer toolbar of a page. */
  inFooter?: boolean;
  inFilterBar?: boolean;
  inValueHelp?: boolean;
  /** The dialog or popover the control sits in. */
  dialog?: { type: string; title: string; text: string; openedBy?: string };
  /** A sap.m.MenuButton whose press only opens its menu (not the split kind, whose main part runs an action). */
  menuOnly?: boolean;
  /** Names of the control's press handlers, where the page shows them. */
  handlers?: string[];
  /** An input of type Password. */
  password?: boolean;
}

export interface ControlRequest {
  /** Id from the view: full id or compact tail, with or without "#". Empty: the focused control. */
  handle: string;
  op: "facts" | "click" | "dblclick" | "fill" | "select" | "check" | "combo" | "f4" | "scroll";
  value?: unknown;
  how?: string;
}

export interface ControlResult {
  /**
   * TARGET: the element to act on is marked. DONE: the action is done (API).
   * TWOSTEP: marked, open it and pick the option. FOCUSENTER: marked, focus
   * it and press Enter. Others: why not.
   */
  status: "TARGET" | "DONE" | "TWOSTEP" | "FOCUSENTER" | "FACTS" | "NOUI5" | "NOTFOUND" | "NODOM" | "NOITEM" | "DISABLED" | "NOTFIT";
  note: string;
  facts?: ControlFacts;
  /** For Enter: the default button of the open dialog. */
  dialogDefault?: ControlFacts;
  /** fill: finish with Enter instead of Tab (search fields). */
  enter?: boolean;
  /** With facts: the logon language of the page (`sap.ui.getCore().getConfiguration().getLanguage()`), e.g. "en-US". */
  language?: string;
}

export function ui5Control(a: ControlRequest): ControlResult {
  const sap = (window as C).sap;
  if (!sap?.ui?.getCore) return { status: "NOUI5", note: "no UI5 in this frame" };
  const ATTR = "data-sap-mcp-target";
  const El = sap.ui.require?.("sap/ui/core/Element") ?? sap.ui.core?.Element;
  const byId = (id: string): C => (El?.getElementById ? El.getElementById(id) : sap.ui.getCore().byId(id));
  const reg = El?.registry ?? sap.ui.getCore().mElements;
  const all: C[] = reg?.all ? Object.values(reg.all()) : Object.values(reg ?? {});
  const text = (s: unknown) =>
    String(s ?? "")
      .replace(/[\s ]+/g, " ")
      .replace(/^ +| +$/g, "");
  const norm = (s: unknown) => text(s).toLowerCase();
  const isA = (c: C, t: string) => {
    try {
      return !!c?.isA?.(t);
    } catch {
      return false;
    }
  };
  const name = (c: C): string => c?.getMetadata?.().getName?.() ?? "";
  const prop = (c: C, n: string) => {
    try {
      return c.getMetadata().getAllProperties()[n] ? c.getProperty(n) : undefined;
    } catch {
      return undefined;
    }
  };
  const controlOf = (el: Element | null): C => {
    for (let e = el; e; e = e.parentElement) if (e.hasAttribute?.("data-sap-ui")) return byId(e.id);
    return null;
  };
  /** An input of type Password, by the control's property or by the element it renders. */
  const isPassword = (c: C): boolean => {
    try {
      if (prop(c, "type") === "Password") return true;
      const d: Element | null = c.getFocusDomRef?.() ?? null;
      if ((d as HTMLInputElement | null)?.type === "password") return true;
      return !!(c.getDomRef?.() as Element | null)?.querySelector?.("input[type='password']");
    } catch {
      return false;
    }
  };
  const language = (): string => {
    try {
      const cfg = sap.ui.getCore().getConfiguration?.();
      return String(cfg?.getLanguage?.() ?? cfg?.getLanguageTag?.() ?? sap.ui.require?.("sap/base/i18n/Localization")?.getLanguage?.() ?? "");
    } catch {
      try {
        return String(sap.ui.require?.("sap/base/i18n/Localization")?.getLanguage?.() ?? "");
      } catch {
        return "";
      }
    }
  };
  const factsOf = (c: C): ControlFacts => {
    const f: ControlFacts = {
      type: name(c),
      id: c.getId(),
      text: text(prop(c, "text") ?? prop(c, "title") ?? prop(c, "header") ?? "") || text(c.getTooltip_AsString?.()),
    };
    const icon = prop(c, "icon");
    if (icon) f.icon = String(icon).replace("sap-icon://", "");
    if (isA(c, "sap.m.Button")) f.buttonType = String(prop(c, "type") ?? "");
    // A menu button, or the one button it renders: in Regular mode a press only opens the menu.
    const menuButton = isA(c, "sap.m.MenuButton") ? c : isA(c, "sap.m.Button") && isA(c.getParent?.(), "sap.m.MenuButton") ? c.getParent() : null;
    if (menuButton) f.menuOnly = prop(menuButton, "buttonMode") !== "Split";
    const href = prop(c, "href");
    if (href && href !== "#") f.href = String(href);
    if (prop(c, "enabled") === false) f.enabled = false;
    for (let p = c, i = 0; p && i < 60; p = p.getParent?.(), i++) {
      const t = name(p);
      if (p.sParentAggregationName === "footer" || /::FooterBar\b/.test(p.getId?.() ?? "")) f.inFooter = true;
      if (/FilterBar|FilterField|FilterItem|FilterGroupItem/.test(t)) f.inFilterBar = true;
      if (/ValueHelp|valuehelp/.test(t) || /valueHelpDialog|ValueHelpDialog|::FieldValueHelp|-valueHelp/.test(p.getId?.() ?? "")) f.inValueHelp = true;
      if (!f.dialog && (isA(p, "sap.m.Dialog") || isA(p, "sap.m.Popover") || isA(p, "sap.m.ActionSheet") || /Menu$/.test(t))) {
        const d: HTMLElement | null = p.getDomRef?.() ?? null;
        f.dialog = {
          type: d?.classList.contains("sapMMessageBox") ? "sap.m.MessageBox" : t,
          title: text(p.getTitle?.() ?? ""),
          text: text(d?.innerText ?? "").slice(0, 400),
        };
        // The control a popover was opened by (the footer's Cancel, for the question "Discard all changes?").
        let by: C = null;
        try {
          by = p._oOpenBy ?? p.getAggregation?.("_popup")?._oOpenBy ?? null;
        } catch {
          /* optional */
        }
        const byId_: string = by?.getId?.() ?? by?.id ?? "";
        if (byId_) f.dialog.openedBy = String(byId_);
      }
    }
    const names: string[] = [];
    try {
      for (const ev of ["press", "tap", "itemPress"])
        for (const h of c.mEventRegistry?.[ev] ?? []) {
          const n = String(h?.fFunction?.name ?? "").replace(/^bound /, "");
          if (n && n !== "anonymous") names.push(n);
        }
    } catch {
      /* handlers are optional */
    }
    if (names.length) f.handlers = names;
    if (isPassword(c)) f.password = true;
    return f;
  };
  /** The button Enter would most likely press in the open dialog. */
  const dialogDefault = (): ControlFacts | undefined => {
    let dialogs: C[] = [];
    try {
      dialogs = sap.ui.require?.("sap/m/InstanceManager")?.getOpenDialogs?.() ?? [];
    } catch {
      /* fall through */
    }
    if (!dialogs.length) dialogs = all.filter((c) => isA(c, "sap.m.Dialog") && c.isOpen?.());
    const d = dialogs[dialogs.length - 1];
    if (!d) return undefined;
    let buttons: C[] = [d.getBeginButton?.(), ...(d.getButtons?.() ?? []), d.getEndButton?.()].filter(Boolean);
    // A dialog with a footer toolbar of its own keeps its buttons there.
    if (!buttons.length) {
      const dom: Element | null = d.getDomRef?.() ?? null;
      buttons = Array.from(dom?.querySelectorAll("footer .sapMBtn, .sapMDialogFooter .sapMBtn") ?? [])
        .map((e) => byId(e.id))
        .filter(Boolean);
    }
    const b = buttons.find((x) => prop(x, "type") === "Emphasized") ?? buttons[0];
    return b ? factsOf(b) : undefined;
  };

  const h = String(a.handle ?? "")
    .replace(/^#/, "")
    .replace(/^id=/, "");
  // Marks set inside the shell bar's shadow tree are not found by the document's own query.
  const shellBars = (): Element[] =>
    all
      .filter((x) => /webcomponents.*\.ShellBar$/.test(name(x)))
      .map((x) => x.getDomRef?.() as Element | null)
      .filter((d): d is Element => !!(d as C)?.shadowRoot);
  // A button the launchpad's shell bar draws inside itself (search, notifications): "shellbar:<name>" in the view.
  if (h.startsWith("shellbar:")) {
    const want = h.slice("shellbar:".length);
    let hit: Element | null = null;
    for (const bar of shellBars())
      for (const b of Array.from((bar as C).shadowRoot.querySelectorAll("[data-ui5-stable].ui5-shellbar-button")) as Element[]) {
        const stable = b.getAttribute("data-ui5-stable") ?? "";
        const tip = text(b.getAttribute("tooltip") ?? b.getAttribute("accessible-name") ?? b.getAttribute("title") ?? "");
        if (!hit && b.getBoundingClientRect().width > 0 && (stable === want || (/-stable-dom-ref$/.test(stable) && tip.toLowerCase().replace(/[^a-z0-9]+/g, "-") === want))) hit = b;
      }
    if (!hit) return { status: "NOTFOUND", note: h };
    const found: Element = hit;
    const tip = text(found.getAttribute("tooltip") ?? found.getAttribute("accessible-name") ?? found.getAttribute("title") ?? "");
    if (a.op === "facts") {
      const lang = language();
      return { status: "FACTS", note: "", facts: { type: "sap.ushell.ShellBarButton", id: h, text: tip }, ...(lang ? { language: lang } : {}) };
    }
    if (a.op !== "click") return { status: "NOTFIT", note: `${h} is a button of the launchpad's shell bar: press it` };
    for (const old of Array.from(document.querySelectorAll(`[${ATTR}]`))) old.removeAttribute(ATTR);
    for (const bar of shellBars()) for (const old of Array.from((bar as C).shadowRoot.querySelectorAll(`[${ATTR}]`)) as Element[]) old.removeAttribute(ATTR);
    found.setAttribute(ATTR, "1");
    // The driver's own clean-up does not reach into the shell bar: the mark goes by itself.
    setTimeout(() => found.removeAttribute(ATTR), 10_000);
    return { status: "TARGET", note: `shell bar button "${tip}"` };
  }
  let c: C = null;
  if (!h) c = controlOf(document.activeElement);
  else {
    c = all.find((x) => x.getId() === h);
    if (!c) {
      const hits = all.filter((x) => {
        const id: string = x.getId();
        return id.endsWith(`--${h}`) || id.endsWith(`::${h}`);
      });
      const vis = hits.filter((x) => x.getDomRef?.()?.getBoundingClientRect?.().width > 0);
      c = (vis.length ? vis : hits)[0];
    }
  }
  if (a.op === "facts") {
    const dd = dialogDefault();
    const lang = language();
    if (!c) return { status: h ? "NOTFOUND" : "FACTS", note: h, ...(dd ? { dialogDefault: dd } : {}), ...(lang ? { language: lang } : {}) };
    return { status: "FACTS", note: "", facts: factsOf(c), ...(dd ? { dialogDefault: dd } : {}), ...(lang ? { language: lang } : {}) };
  }

  for (const old of Array.from(document.querySelectorAll(`[${ATTR}]`))) old.removeAttribute(ATTR);
  for (const bar of shellBars()) for (const old of Array.from((bar as C).shadowRoot.querySelectorAll(`[${ATTR}]`)) as Element[]) old.removeAttribute(ATTR);
  const mark = (dom: Element | null | undefined, note: string, status: ControlResult["status"] = "TARGET"): ControlResult => {
    if (!dom) return { status: "NODOM", note: `${name(c)} ${c.getId()} is not on screen` };
    // A table greyed out after a filter change takes no click until Go is pressed: said at once, not after a click that waits.
    const grey = dom.closest(".sapUiMdcTable, .sapUiCompSmartTable, .sapMList, .sapUiTable")?.querySelector(".sapUiOverlay");
    if (grey) {
      const o = grey.getBoundingClientRect();
      const r = dom.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (o.width > 0 && x >= o.left && x <= o.right && y >= o.top && y <= o.bottom)
        return { status: "NOTFIT", note: `${name(c)} ${c.getId()} is in a table that is greyed out: the filters changed and its rows are the old ones. Press Go in the filter bar first, then act on the table.` };
    }
    dom.setAttribute(ATTR, "1");
    return { status, note };
  };

  // ---- scroll: the area around a control, the open popup, or the page's main area
  if (a.op === "scroll") {
    const how = String(a.how ?? a.value ?? "down").toLowerCase();
    const scrollable = (e: Element) => e.scrollHeight > e.clientHeight + 20 && e.clientHeight >= 80 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && (e as HTMLElement).offsetWidth > 0;
    let target: Element | null = null;
    if (h) {
      if (!c) return { status: "NOTFOUND", note: h };
      const d: Element | null = c.getDomRef?.() ?? null;
      if (!d) return { status: "NODOM", note: `${name(c)} ${c.getId()} is not on screen` };
      if (how === "to" || how === "show") {
        d.scrollIntoView({ block: "center" });
        return { status: "DONE", note: `scrolled to ${name(c)}` };
      }
      target = Array.from(d.querySelectorAll("*")).find(scrollable) ?? null;
      for (let e: Element | null = d; e && !target; e = e.parentElement) if (scrollable(e)) target = e;
    } else {
      const popups = Array.from(document.querySelectorAll(".sapMDialog, .sapMPopover")).filter((e) => (e as HTMLElement).offsetWidth > 0);
      const scope: ParentNode = popups[popups.length - 1] ?? document;
      let area = 0;
      for (const e of Array.from(scope.querySelectorAll("*"))) {
        if (e.clientWidth < 80 || !scrollable(e)) continue;
        const r = e.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight) continue;
        const ar = e.clientHeight * e.clientWidth;
        if (ar > area) {
          area = ar;
          target = e;
        }
      }
    }
    if (!target) return { status: "DONE", note: "nothing to scroll here" };
    const step = Math.max(100, Math.round(target.clientHeight * 0.85));
    if (how === "top") target.scrollTop = 0;
    else if (how === "bottom") target.scrollTop = target.scrollHeight;
    else if (how === "up") target.scrollTop -= step;
    else target.scrollTop += step;
    const top = Math.round(target.scrollTop);
    return { status: "DONE", note: `scrolled ${how}: now ${top}-${top + target.clientHeight} of ${target.scrollHeight} px` };
  }

  if (!c) return { status: "NOTFOUND", note: h };
  const what = `${name(c)} ${c.getId()}`;
  if (prop(c, "enabled") === false) return { status: "DISABLED", note: `${what} is disabled` };

  // ---- dropdown entry through the control's API
  const pick = a.value == null ? "" : String(a.value);
  const listLike = isA(c, "sap.m.Select") || isA(c, "sap.m.ComboBox") || isA(c, "sap.m.MultiComboBox");
  if (a.op === "combo" || (a.op === "select" && listLike && pick)) {
    if (!listLike) return mark(c.getFocusDomRef?.() ?? c.getDomRef?.(), what, "TWOSTEP");
    if (prop(c, "editable") === false) return { status: "DISABLED", note: `${what} is read-only` };
    const items: C[] = (c.getSelectableItems?.() ?? c.getItems?.() ?? []).filter((x: C) => x.getEnabled?.() !== false);
    if (a.op === "combo" && !pick) {
      const list = items
        .slice(0, 60)
        .map((x: C) => `${x.getKey?.() ?? ""}:${text(x.getText?.())}`)
        .join(", ");
      return { status: "DONE", note: `${what}: nothing chosen. Entries (key:text): ${list}${items.length > 60 ? `, ... (${items.length} in all)` : ""}` };
    }
    const it =
      items.find((x: C) => norm(x.getKey?.()) === norm(pick) || norm(x.getText?.()) === norm(pick)) ??
      (pick ? items.find((x: C) => norm(x.getText?.()).startsWith(norm(pick))) : undefined) ??
      (pick ? items.find((x: C) => norm(x.getText?.()).includes(norm(pick))) : undefined);
    if (!it) {
      const list = items
        .slice(0, 40)
        .map((x: C) => `${x.getKey?.() ?? ""}:${text(x.getText?.())}`)
        .join(", ");
      return { status: "NOITEM", note: `no entry "${pick}" in ${what}. Entries (key:text): ${list}${items.length > 40 ? `, ... (${items.length} in all)` : ""}` };
    }
    if (isA(c, "sap.m.MultiComboBox")) {
      c.addSelectedItem(it);
      c.fireSelectionChange?.({ changedItem: it, selected: true });
      c.fireSelectionFinish?.({ selectedItems: c.getSelectedItems?.() ?? [] });
    } else {
      c.setSelectedItem(it);
      c.fireChange?.({ selectedItem: it, value: it.getText(), itemPressed: true });
      c.fireSelectionChange?.({ selectedItem: it });
    }
    return { status: "DONE", note: `chose "${text(it.getText())}" in ${what}` };
  }

  // ---- the anchor-bar entry of an object-page section
  const anchorOf = (sec: C): Element | null => {
    let opl: C = sec;
    while (opl && !isA(opl, "sap.uxap.ObjectPageLayout")) opl = opl.getParent?.();
    const bar = opl?.getAggregation?.("_anchorBar");
    const entries: C[] = bar?.getItems?.() ?? bar?.getContent?.() ?? [];
    const e = entries.find((x: C) => x.getKey?.() === sec.getId() || x.data?.("sectionId") === sec.getId());
    return e?.getDomRef?.() ?? null;
  };

  if (a.op === "fill") {
    // A password is never typed by this server.
    if (isPassword(c)) return { status: "NOTFIT", note: `${what} is a password field: this server never types a password. Type it yourself.` };
    if (prop(c, "editable") === false) return { status: "DISABLED", note: `${what} is read-only` };
    // "" on a field that holds tokens (a filter's values, "=24"): the tokens go, as the user removes them one by one.
    // Typing nothing left them there (live 2026-11-20: the agent then fought with Backspace and Delete).
    if ((a.value === "" || a.value == null) && typeof c.getTokens === "function" && typeof c.removeAllTokens === "function") {
      const tokens = c.getTokens() as C[];
      if (tokens.length) {
        c.removeAllTokens();
        c.fireTokenUpdate?.({ type: "removed", addedTokens: [], removedTokens: tokens });
        c.fireChange?.({ value: "" });
        return { status: "DONE", note: `${what}: removed ${tokens.length} value${tokens.length > 1 ? "s" : ""} (${tokens.map((t) => `"${text(t.getText?.())}"`).slice(0, 10).join(", ")})` };
      }
    }
    let d: Element | null = c.getFocusDomRef?.() ?? null;
    if (!d?.matches?.("input,textarea")) d = (c.getDomRef?.() as Element | null)?.querySelector?.("input:not([type=checkbox]):not([type=radio]),textarea") ?? null;
    if (!d) return { status: "NOTFIT", note: `${what} is not an input field` };
    if ((d as HTMLInputElement).type === "password") return { status: "NOTFIT", note: `${what} is a password field: this server never types a password. Type it yourself.` };
    const r = mark(d, what);
    if (isA(c, "sap.m.SearchField")) r.enter = true;
    return r;
  }

  if (a.op === "check") {
    let cur: boolean | null = null;
    let dom: Element | null = c.getDomRef?.() ?? null;
    if (isA(c, "sap.m.CheckBox") || isA(c, "sap.m.RadioButton")) cur = !!c.getSelected();
    else if (isA(c, "sap.m.Switch")) cur = !!c.getState();
    else if (isA(c, "sap.m.ToggleButton")) cur = !!c.getPressed();
    else if (isA(c, "sap.m.ListItemBase") && /Select/.test(c.getParent?.()?.getMode?.() ?? "")) {
      cur = !!c.getSelected();
      dom = c.getModeControl?.()?.getDomRef?.() ?? dom;
    } else if (isA(c, "sap.ui.table.Row")) {
      const t = c.getParent?.();
      const i = (t?.getRows?.() ?? []).indexOf(c);
      // With a selection plugin the table's own isIndexSelected() throws: ask the plugin.
      try {
        const plugin = [...(t?.getDependents?.() ?? []), ...(t?.getPlugins?.() ?? [])].find((p: C) => isA(p, "sap.ui.table.plugins.SelectionPlugin"));
        cur = plugin ? (plugin.isSelected ? !!plugin.isSelected(c) : !!plugin.isIndexSelected?.(c.getIndex?.())) : !!t?.isIndexSelected?.(c.getIndex?.());
      } catch {
        return { status: "NOTFIT", note: `${what}: the table does not say whether this row is selected; use select on the row` };
      }
      dom = document.getElementById(`${t?.getId()}-rowsel${i}`) ?? dom;
    }
    if (cur === null) return { status: "NOTFIT", note: `${what} is not a checkbox or switch` };
    const v = a.value;
    const want = v === undefined || v === null ? !cur : !(v === false || v === 0 || /^(false|0|off|no|)$/i.test(String(v)));
    if (cur === want) return { status: "DONE", note: `${what} is already ${want ? "checked" : "unchecked"}` };
    return mark(dom, `${what} -> ${want ? "checked" : "unchecked"}`);
  }

  if (a.op === "f4") {
    const vhi = c.getDomRef?.("vhi") ?? (c.getDomRef?.() as Element | null)?.querySelector?.("[id$='-vhi']");
    if (vhi) return mark(vhi, `value help of ${what}`);
    return mark(c.getFocusDomRef?.() ?? c.getDomRef?.(), `value help of ${what}`, "TWOSTEP");
  }

  /**
   * Where to click a table row so that the row itself is pressed: a cell that
   * holds no link, button or input (the centre of a row can be a link with
   * its own action). The navigation arrow's cell when the row has one.
   */
  const quietCell = (row: C): Element | null => {
    const d: Element | null = row.getDomRef?.() ?? null;
    if (!d) return null;
    const busy = "a, button, input, textarea, select, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='combobox'], .sapMLnk, .sapMBtn, .sapMObjStatusActive, .sapMObjectNumberActive";
    const pressable = (cell: Element) => {
      if (cell.querySelector(busy)) return true;
      for (const e of Array.from(cell.querySelectorAll("[data-sap-ui]"))) {
        try {
          if (byId(e.id)?.hasListeners?.("press")) return true;
        } catch {
          /* not a control */
        }
      }
      return false;
    };
    const cells = Array.from(d.querySelectorAll("td, [role='gridcell']")).filter((cell) => {
      const r = cell.getBoundingClientRect();
      return r.width >= 12 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && !cell.matches(".sapMListTblSelCol, .sapMListTblHighlightCell, .sapMListTblNavigatedCell, .sapUiTableRowSelectionCell, .sapUiTableRowActionCell");
    });
    const nav = cells.find((cell) => cell.matches(".sapMListTblNavCol") && cell.querySelector("[id$='-imgNav']"));
    return nav ?? cells.find((cell) => !cell.matches(".sapMListTblNavCol") && !pressable(cell)) ?? null;
  };

  let dom: Element | null = null;
  if (isA(c, "sap.ui.table.Row")) {
    // A grid-table row whose table selects only through row selectors (V2 value help): click its selector.
    const t = c.getParent?.();
    const i = (t?.getRows?.() ?? []).indexOf(c);
    if (t && i >= 0 && t.getSelectionMode?.() !== "None" && (a.op === "select" || t.getSelectionBehavior?.() === "RowSelector")) dom = document.getElementById(`${t.getId()}-rowsel${i}`);
  } else if (a.op === "select" && isA(c, "sap.m.ListItemBase")) {
    // A list item's own selection control, where the list has one; else the item.
    dom = c.getModeControl?.()?.getDomRef?.() ?? null;
  } else if (isA(c, "sap.uxap.ObjectPageSectionBase")) {
    dom = anchorOf(c);
    if (!dom) {
      let opl: C = c;
      while (opl && !isA(opl, "sap.uxap.ObjectPageLayout")) opl = opl.getParent?.();
      if (!opl?.scrollToSection) return { status: "NOTFIT", note: `${what} has no anchor` };
      opl.scrollToSection(c.getId());
      return { status: "DONE", note: `scrolled to section "${text(c.getTitle?.())}"` };
    }
  } else if (isA(c, "sap.m.SegmentedButtonItem")) dom = c.getDomRef?.() ?? c.oButton?.getDomRef?.() ?? null;
  // Pressing a table row: a place in it that is the row's own. Without one, Enter on the row presses it.
  if (!dom && a.op === "click" && (isA(c, "sap.m.ColumnListItem") || isA(c, "sap.ui.table.Row"))) {
    dom = quietCell(c);
    if (!dom && isA(c, "sap.m.ColumnListItem") && /Navigation|Active|Detail/.test(c.getType?.() ?? "")) return mark(c.getDomRef?.(), what, "FOCUSENTER");
  }
  return mark(dom ?? c.getDomRef?.(), what);
}

export interface IdleOptions {
  timeoutMs: number;
  /** Use sap/ui/test/RecordReplay.waitForUI5 (loads the module into the page once). */
  recordReplay: boolean;
}

/** Resolves when UI5 is idle, with how it knew; "busy: ..." when the time ran out. */
export async function ui5Idle(o: IdleOptions): Promise<string> {
  const sap = (window as C).sap;
  if (!sap?.ui?.getCore) return "no UI5";
  const t0 = Date.now();
  /** UI5's own busy and pending-request state, then the busy indicators on screen. */
  const busyNow = (): string => {
    try {
      const R = sap.ui.require?.("sap/ui/core/Rendering");
      if (R?.isPending?.() ?? sap.ui.getCore().getUIDirty?.()) return "rendering";
    } catch {
      /* next */
    }
    try {
      if (sap.ui.require?.("sap/ui/core/BusyIndicator")?.oPopup?.isOpen?.()) return "busy indicator";
    } catch {
      /* next */
    }
    try {
      const comps = sap.ui.require?.("sap/ui/core/Component")?.registry?.all?.() ?? {};
      for (const c of Object.values(comps) as C[]) for (const m of Object.values(c?.oModels ?? {}) as C[]) if (m?.hasPendingRequests?.()) return "OData request";
    } catch {
      /* next */
    }
    // The block layer behind a modal dialog (.sapUiBLy) is not a busy sign.
    const b = Array.from(document.querySelectorAll(".sapUiLocalBusyIndicator, .sapMBusyDialog, .sapMBusyIndicator")).filter(
      (e) => (e as HTMLElement).offsetWidth > 0 && getComputedStyle(e).visibility !== "hidden" && !(e as HTMLElement).closest(".sapUiHidden"),
    );
    // With a popup open, only what is busy inside it holds the user up (a footer button stays busy behind its own popover).
    const popups = Array.from(document.querySelectorAll(".sapMDialog, .sapMPopover")).filter((e) => (e as HTMLElement).offsetWidth > 0);
    const top = popups[popups.length - 1];
    const held = top && !top.classList.contains("sapMBusyDialog") ? b.filter((e) => top.contains(e) || e.classList.contains("sapMBusyDialog")) : b;
    busyIds = held
      .map((e) => (e.closest("[data-sap-ui]") as HTMLElement | null)?.id ?? "")
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return held.length ? "busy control" : "";
  };
  /** The controls that show a busy sign now (their ids), for the note. */
  let busyIds = "";
  /** A busy sign that stays the same this long, with nothing else pending, is not waited for: a tile that never loads, a button kept busy. */
  const SAME_BUSY_MS = 5000;
  let sameSince = 0;
  let sameIds = "";
  let how = "busy state";
  if (o.recordReplay) {
    const RR: C = await new Promise((res) => {
      const have = sap.ui.require?.("sap/ui/test/RecordReplay");
      if (have) return res(have);
      try {
        sap.ui.require(["sap/ui/test/RecordReplay"], res, () => res(null));
      } catch {
        res(null);
      }
      setTimeout(() => res(null), 5000);
    });
    if (RR?.waitForUI5) {
      try {
        await RR.waitForUI5({ timeout: Math.min(o.timeoutMs, 15000), interval: 100 });
        how = "waitForUI5";
      } catch {
        how = "waitForUI5 timed out, busy state";
      }
    }
  }
  let quiet = 0;
  let last = "";
  const need = how === "waitForUI5" ? 1 : 3;
  for (;;) {
    last = busyNow();
    quiet = last ? 0 : quiet + 1;
    if (quiet >= need) return `idle (${how}, ${Date.now() - t0} ms)`;
    if (last === "busy control") {
      if (busyIds !== sameIds || !sameSince) {
        sameIds = busyIds;
        sameSince = Date.now();
      } else if (Date.now() - sameSince >= SAME_BUSY_MS) return `idle (${how}, ${Date.now() - t0} ms; still shown as busy and not waited for: ${busyIds || "a busy indicator"})`;
    } else sameSince = 0;
    if (Date.now() - t0 > o.timeoutMs) return `busy: ${last === "busy control" && busyIds ? `${busyIds} is busy` : last || "not settled"} after ${Date.now() - t0} ms`;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Opens a launchpad app by its intent ("#SalesOrder-manage"): sets the
 * launchpad's hash, as a bookmark of the app does. The page and its origin
 * stay; the launchpad asks before unsaved input is lost, as on any navigation.
 */
export function ui5Open(hash: string): "OK" | "SAME" | "NOSHELL" {
  const sap = (window as C).sap;
  let container: C = null;
  try {
    container = sap?.ui?.require?.("sap/ushell/Container") ?? sap?.ushell?.Container ?? null;
  } catch {
    /* no launchpad */
  }
  if (!container) return "NOSHELL";
  if (decodeURIComponent(location.hash) === decodeURIComponent(hash)) return "SAME";
  location.hash = hash;
  return "OK";
}

/**
 * Back in a launchpad: marks the shell's back button when it shows (the
 * driver clicks it). Without one: "HISTORY" when the tab has an earlier
 * launchpad page. When the page before this one in the tab's history is not
 * the launchpad (the app is the first page of the tab: what was there before
 * is about:blank or another site), neither the button nor the history is
 * used, both would leave SAP and lose the session: the home page is opened
 * ("HOME"), or nothing is done on the home page itself ("ATHOME").
 */
export async function ui5Back(attr: string): Promise<"BUTTON" | "HISTORY" | "HOME" | "ATHOME"> {
  const sap = (window as C).sap;
  let container: C = null;
  try {
    container = sap?.ui?.require?.("sap/ushell/Container") ?? sap?.ushell?.Container ?? null;
  } catch {
    /* no launchpad */
  }
  if (!container) return "HISTORY";
  for (const old of Array.from(document.querySelectorAll(`[${attr}]`))) old.removeAttribute(attr);
  // Does one step back in the tab's history leave the launchpad? The browser's own list of this tab's entries
  // says it (the Navigation API lists the entries of this site only: no entry before this one means that the
  // step back goes elsewhere). undefined when the browser has no such list.
  let leaves: boolean | undefined;
  try {
    const nav: C = (window as C).navigation;
    const entries: C[] = nav.entries();
    const prev = entries[nav.currentEntry.index - 1];
    if (!prev) leaves = true;
    else {
      const u = new URL(String(prev.url));
      leaves = u.origin !== location.origin || u.pathname !== location.pathname;
    }
  } catch {
    leaves = undefined;
  }
  const btn = document.getElementById("backBtn");
  const button = !!btn && btn.getBoundingClientRect().width > 0 && (btn as C).checkVisibility?.() !== false;
  if (leaves === undefined) {
    // No list of entries: the launchpad says whether this app is the first one it opened in this tab.
    try {
      const nav: C = await Promise.race([container.getServiceAsync?.("CrossApplicationNavigation"), new Promise((r) => setTimeout(() => r(null), 2000))]);
      leaves = ((await nav?.isInitialNavigationAsync?.()) ?? nav?.isInitialNavigation?.() ?? false) && !button;
    } catch {
      leaves = false;
    }
  }
  if (leaves) {
    if (/^#?(Shell-home)?$/.test(location.hash)) return "ATHOME";
    location.hash = "#Shell-home";
    return "HOME";
  }
  if (button && btn) {
    btn.setAttribute(attr, "1");
    return "BUTTON";
  }
  return "HISTORY";
}

export interface Ui5Info {
  ui5: boolean;
  version?: string;
  /** A launchpad (sap.ushell) runs in the page. */
  launchpad: boolean;
  user?: string;
  system?: string;
  client?: string;
  /** "#SalesOrder-manage" -> "SalesOrder-manage". */
  intent?: string;
  /** Fiori app id (F1873) or the component name of the app. */
  appId?: string;
  title: string;
  /** Where each fact came from, for the doctor and the report. */
  sources: Record<string, string>;
}

export async function ui5Info(): Promise<Ui5Info> {
  const w = window as C;
  const sap = w.sap;
  const out: Ui5Info = { ui5: !!sap?.ui?.getCore, launchpad: false, title: document.title, sources: {} };
  const set = (k: "user" | "system" | "client" | "appId", v: unknown, src: string) => {
    const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    if (s && !out[k]) {
      out[k] = s;
      out.sources[k] = src;
    }
  };
  const within = <T>(p: Promise<T> | T, ms: number): Promise<T | undefined> => Promise.race([Promise.resolve(p), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  const intent = /^#([A-Za-z0-9_]+-[A-Za-z0-9_]+)/.exec(location.hash)?.[1];
  if (intent) out.intent = intent;
  if (!out.ui5) {
    set("client", new URLSearchParams(location.search).get("sap-client"), "URL sap-client");
    return out;
  }
  try {
    out.version = String(sap.ui.version ?? sap.ui.getVersionInfo?.()?.version ?? "");
  } catch {
    /* optional */
  }
  let container: C = null;
  try {
    container = sap.ui.require?.("sap/ushell/Container") ?? sap.ushell?.Container ?? null;
  } catch {
    /* no launchpad */
  }
  if (container) {
    out.launchpad = true;
    try {
      set("user", container.getUser?.()?.getId?.(), "sap.ushell.Container.getUser().getId()");
    } catch {
      /* next */
    }
    try {
      const s = container.getLogonSystem?.();
      set("system", s?.getName?.(), "sap.ushell.Container.getLogonSystem().getName()");
      set("client", s?.getClient?.(), "sap.ushell.Container.getLogonSystem().getClient()");
    } catch {
      /* next */
    }
    try {
      const ui = (await within(container.getServiceAsync?.("UserInfo"), 2000)) as C;
      set("user", ui?.getId?.(), "UserInfo service getId()");
    } catch {
      /* next */
    }
    try {
      const life = (await within(container.getServiceAsync?.("AppLifeCycle"), 2000)) as C;
      const app = life?.getCurrentApplication?.();
      if (app && !app.homePage) {
        const ids = (await within(app.getTechnicalParameter?.("sap-fiori-id"), 2000)) as string[] | undefined;
        set("appId", ids?.[0], "AppLifeCycle sap-fiori-id");
        set("appId", app.componentInstance?.getManifestEntry?.("/sap.app/id"), "app manifest sap.app/id");
      }
    } catch {
      /* next */
    }
  }
  // The launchpad's start-up configuration names the system too.
  try {
    const sys = w["sap-ushell-config"]?.services?.Container?.adapter?.config;
    set("system", sys?.systemProperties?.SID ?? sys?.system, "sap-ushell-config system");
    set("client", sys?.systemProperties?.client ?? sys?.client, "sap-ushell-config client");
    set("user", sys?.id, "sap-ushell-config user id");
  } catch {
    /* next */
  }
  set("client", new URLSearchParams(location.search).get("sap-client"), "URL sap-client");
  if (!out.appId) {
    // A stand-alone app: the first component that is an application.
    try {
      const comps = Object.values(sap.ui.require?.("sap/ui/core/Component")?.registry?.all?.() ?? {}) as C[];
      const app = comps.find((c) => c.getManifestEntry?.("/sap.app/type") === "application" && !/^sap\.ushell/.test(c.getManifestEntry?.("/sap.app/id") ?? ""));
      set("appId", app?.getManifestEntry?.("/sap.app/id"), "component manifest sap.app/id");
    } catch {
      /* optional */
    }
  }
  return out;
}

/**
 * Is this page a logon page? Runs in the top frame, with or without UI5.
 * A logon page shows a password input and either carries the names SAP's
 * logon pages use (the ABAP system logon, the Fiori logon, SAP Identity
 * Authentication, the Java logon), or runs no app at all (no UI5 component,
 * no launchpad). A password field inside a running app is not a logon page:
 * the reader masks it and "set" refuses it.
 */
export function ui5Logon(): boolean {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const passwords = Array.from(document.querySelectorAll("input[type='password']")).filter(shown);
  if (!passwords.length) return false;
  const known =
    "#LOGIN_FORM, #LOGIN_MAIN, #LOGIN_SUBMIT_BLOCK, #USERNAME_FIELD-inner, #PASSWORD_FIELD-inner, #LOGIN_LINK, #sap-user, #sap-password, [name='sap-user'], [name='sap-password'], form[name='loginForm'], form[name='logonForm'], #logOnForm, #logOnFormSubmit, [name='j_username'], [name='j_password'], #j_username, #j_password";
  if (document.querySelector(known)) return true;
  // biome-ignore lint/suspicious/noExplicitAny: UI5 globals
  const sap = (window as any).sap;
  if (!sap?.ui?.getCore) return true;
  try {
    if (sap.ui.require?.("sap/ushell/Container") ?? sap.ushell?.Container) return false;
    const comps = Object.values(sap.ui.require?.("sap/ui/core/Component")?.registry?.all?.() ?? {});
    return comps.length === 0;
  } catch {
    return true;
  }
}
