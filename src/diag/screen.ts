/**
 * What a DIAG decoder knows about one SAP GUI session (a "mode") after a
 * dialog step: the screen as the application server described it.
 *
 * Positions are in character cells, counted from the top left of the
 * window's screen area (the dynpro area below the toolbars): `row` and `col`
 * are absolute in that area, whatever subscreen, tab page or table the
 * element sits in. A popup has its own area; its `position` says where it
 * lies over the main window.
 */

export interface DiagScreen {
  /** DIAG mode number: one SAP GUI connection carries several sessions, one per mode. */
  mode: number;
  /** Dialog steps of this mode seen so far (1 for the first screen). */
  step: number;
  session: DiagSession;
  /** The main window first, then the modal popups above it; the last one has the input. */
  windows: DiagWindow[];
  /** Status bar of the step, when the server sent one. */
  message?: DiagStatus;
  /** The command the user last sent in the command field (e.g. "/nVA03"), when seen. */
  lastCommand?: string;
}

export interface DiagSession {
  /** System id (database name), e.g. "ABA". */
  system?: string;
  client?: string;
  user?: string;
  language?: string;
  /** Application server host. */
  host?: string;
  /** Transaction code. */
  tcode?: string;
  /** Text SAP GUI shows for the session in the system info, e.g. "SAP R/3 (1) ABA". */
  label?: string;
  /** Kernel release as sent, e.g. "750". */
  kernel?: string;
  /** Internal mode number (the session's number on the server). */
  internalMode?: number;
  codepage?: string;
}

export interface DiagStatus {
  /** S success, I information, W warning, E error, A abort, X exit; "" when the server gave none. */
  type: string;
  text: string;
  /** Message class and number, when sent (e.g. "V1", "311"). */
  id?: string;
  number?: string;
}

export interface DiagArea {
  row: number;
  col: number;
  /** Width and height in character cells; 0 when not known. */
  width: number;
  height: number;
}

export interface DiagWindow {
  /** 0 for the main window, 1 and up for modal popups. */
  index: number;
  modal: boolean;
  /** Title bar. For a popup that a control draws by itself (value help), the control's caption. */
  title: string;
  /** The dynpro's own title when a control's caption replaced it ("MCX_DUMMY_POPUP"). */
  dynproTitle?: string;
  /** Program and screen number of the dynpro, GUI status and the program that owns it. */
  program: string;
  dynpro: string;
  guiStatus: string;
  guiStatusProgram: string;
  /** Size of the screen area in character cells (AREASIZE). */
  size: { rows: number; cols: number };
  /** Size of the whole window in character cells, when it differs. */
  windowSize?: { rows: number; cols: number };
  /** Popups: where the window lies over the main window, in the main window's cells. */
  position?: { row: number; col: number };
  /** How far the screen is larger than its area, and where it is scrolled to. */
  scroll?: DiagScroll;
  /** Menu bar, as a tree. */
  menus: DiagMenuEntry[];
  /** Application toolbar buttons. */
  toolbar: DiagKey[];
  /** Function keys that are active (the standard toolbar's Back, Exit, Cancel are among them). */
  keys: DiagKey[];
  /** Fields, labels, buttons, checkboxes... in the order the server sent them. */
  elements: DiagElement[];
  tabstrips: DiagTabstrip[];
  tables: DiagTable[];
  /** A classic list (report output, F4 hit list) in the screen area. */
  list?: DiagList;
  /** Controls (ALV grid, tree, text editor...) whose container is on this screen. */
  controls: DiagControl[];
  /** Custom containers of the screen: where a control goes. */
  containers: DiagContainer[];
  /** Where the cursor is, when the server set it on a plain element. */
  focus?: { row: number; col: number; name?: string };
}

export interface DiagScroll {
  /** Size of the whole screen in cells. */
  rows: number;
  cols: number;
  /** Cells that fit in the area. */
  visibleRows: number;
  visibleCols: number;
  /** First row and column on show (0 when not scrolled). */
  firstRow: number;
  firstCol: number;
}

export interface DiagMenuEntry {
  /** Position path from the menu bar, 1-based: [3] the third menu, [3, 2] its second entry. */
  path: number[];
  text: string;
  /** Underlined letter. */
  accelerator: string;
  enabled: boolean;
  separator: boolean;
  /** Function key bound to the entry, when it has one. */
  vkey?: number;
  /** Function code, when the server sends it. */
  fcode?: string;
  children: DiagMenuEntry[];
}

export interface DiagKey {
  /** SAP virtual key number: 0 Enter, 1-12 F1-F12, 13-24 Shift+, 25-36 Ctrl+, 37-48 Ctrl+Shift+. */
  vkey: number;
  /** Name of the key, e.g. "Shift+F3". */
  key: string;
  text: string;
  tooltip: string;
  icon: string;
  enabled: boolean;
  fcode?: string;
}

export type DiagElementKind = "field" | "label" | "checkbox" | "radio" | "button" | "dropdown" | "group" | "other";

export interface DiagElement {
  kind: DiagElementKind;
  /** SAP field name (e.g. "VBAK-VBELN"); "" when the server gave none. */
  name: string;
  /** Value of a field, text of a label, button, checkbox or group box. Never the content of a hidden field. */
  text: string;
  /** Text of the label that stands for it: to its left on the same row. */
  label?: string;
  tooltip?: string;
  icon?: string;
  /** Absolute position in the window's screen area. */
  row: number;
  col: number;
  /** Width in cells (visible length); group boxes also have a height. */
  width: number;
  height?: number;
  /** Can the user type in it, tick it, choose in it? */
  input: boolean;
  /** Hidden content (password) or an element the screen does not show. */
  hidden: boolean;
  /** Outside the visible part of a subscreen that scrolls: on the screen only after scrolling there. */
  scrolledOut?: boolean;
  /** Has value help (F4). */
  valueHelp?: boolean;
  /** An input field the user has to fill (the server sends "?" as its content). */
  required?: boolean;
  /** Longest value it takes, in characters. */
  maxLength?: number;
  checked?: boolean;
  /** Function code a button, a tab, a checkbox or a radio button sends. */
  fcode?: string;
  /** Dropdown: the selected key and the id of its value list (the entries are not in the stream when SAP GUI has them cached). */
  key?: string;
  valueList?: string;
  /** Names of the containers it sits in, outermost first ("SUBSCREEN_HEADER:SAPMV45A:4021"). */
  path: string[];
  /** Raw element type of the protocol, for debugging. */
  etype: number;
}

export interface DiagTab {
  /** Id of the tab ("T\\01"). */
  id: string;
  name: string;
  text: string;
  tooltip?: string;
  icon?: string;
  fcode: string;
  active: boolean;
  /** Position among the tabs, 0-based. */
  index: number;
  row: number;
  /** Column where the tab's caption starts, estimated from the captions before it. */
  col: number;
}

export interface DiagTabstrip extends DiagArea {
  name: string;
  tabs: DiagTab[];
  /** Area of the open tab page, when the server sent one. */
  page?: DiagArea;
  path: string[];
}

export interface DiagTableColumn {
  /** Index in the table's own order, 0-based: cells refer to it. */
  index: number;
  /** Position on the screen, 0-based, after the user's column moves. */
  position: number;
  /** SAP field name. */
  name: string;
  title: string;
  tooltip?: string;
  /** Width in cells. */
  width: number;
  /** Absolute column where it starts, and whether it is inside the table's width (estimated from the widths; false when scrolled out to the right). */
  col: number;
  visible: boolean;
}

export interface DiagTableCell {
  column: number;
  text: string;
  kind: DiagElementKind;
  input: boolean;
  hidden: boolean;
  checked?: boolean;
  key?: string;
  valueList?: string;
  maxLength?: number;
}

export interface DiagTableRow {
  /** Line of the table this row shows, 0-based. */
  index: number;
  /** Absolute screen row. */
  row: number;
  /** True when the row has nothing in it (an empty input line or a line past the data). */
  empty: boolean;
  /** One cell per column, in the table's own column order. */
  cells: DiagTableCell[];
}

export interface DiagTable extends DiagArea {
  name: string;
  program: string;
  title: string;
  columns: DiagTableColumn[];
  /** The rows the server sent: those on show. */
  rows: DiagTableRow[];
  /** Lines of the table as the server counts them, and how many the screen shows. */
  totalRows?: number;
  visibleRows?: number;
  path: string[];
}

export interface DiagListCell {
  col: number;
  text: string;
  tooltip?: string;
  icon?: string;
  /** Width of the cell in cells. */
  width: number;
}

export interface DiagListRow {
  /** Row of the screen area. */
  row: number;
  cells: DiagListCell[];
}

export interface DiagList {
  /** Rows sent: the page on show. Lines of frame characters are left out. */
  rows: DiagListRow[];
  /** Lines of the whole list, when the server said. */
  totalRows?: number;
  /** Line the page starts at, 0-based. */
  firstRow?: number;
}

export interface DiagContainer extends DiagArea {
  name: string;
  path: string[];
}

export type DiagControlKind = "grid" | "tree" | "text" | "toolbar" | "html" | "picture" | "container" | "splitter" | "other";

export interface DiagGridColumn {
  name: string;
  /** Long column text. */
  title: string;
  /** Every header text the grid may show, by column width (long, medium, short), without repeats. */
  titles: string[];
  tooltip: string;
  width: number;
  /** Position on the screen, 0-based. */
  position: number;
}

export interface DiagGrid {
  columns: DiagGridColumn[];
  /** Rows the server sent so far (it sends the first block, more on demand). */
  rows: { index: number; cells: string[] }[];
  totalRows: number;
}

export interface DiagTreeNode {
  key: string;
  parent: string;
  depth: number;
  /** Text of the node: of its first item. */
  text: string;
  /** Texts of all items, by item (column) name. */
  items: Record<string, string>;
  folder: boolean;
  expanded: boolean;
  hidden: boolean;
  disabled: boolean;
}

export interface DiagTree {
  /** Column headers, the hierarchy column first. */
  headers: string[];
  /** Every node the server sent, in display order (children after their parent). */
  nodes: DiagTreeNode[];
  selected?: string;
}

export interface DiagControl {
  /** Shell id of the control framework. */
  id: number;
  kind: DiagControlKind;
  /** Class of the front-end control, e.g. "SAPGUI.GridViewCtrl.1". */
  type: string;
  /** Shell id of its parent control, when it has one. */
  parent?: number;
  /** Name of the custom container it (or its ancestor) is linked to. */
  container?: string;
  /** Area of that container, when it is on the screen. */
  area?: DiagArea;
  /** The dynpro it belongs to when it has no container: the control-based value help (F4) draws its whole popup itself. */
  dynpro?: { program: string; number: number };
  /** Caption the control shows for itself (the value help: "Sales Document Type (1)"). */
  title?: string;
  grid?: DiagGrid;
  tree?: DiagTree;
  text?: string;
  readOnly?: boolean;
}
