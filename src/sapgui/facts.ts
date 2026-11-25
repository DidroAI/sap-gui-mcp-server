/**
 * What the PowerShell host (ps/host.ps1) reports: raw facts read through
 * SAP GUI scripting, before any formatting. Texts are as SAP GUI gives them.
 */

/** One control. Which optional facts are present depends on its type. */
export interface Control {
  /** Scripting id inside the session, e.g. "wnd[0]/usr/ctxtVBAK-AUART". */
  id: string;
  /** Scripting type, e.g. "GuiCTextField", "GuiShell". */
  type: string;
  /** SAP field name, e.g. "VBAK-AUART". */
  name: string;
  text?: string;
  tip?: string;
  changeable?: boolean;
  selected?: boolean;
  /** Text of the label to the left of a field or dropdown. */
  label?: string;
  /** Dropdown: selected key, and every entry as [key, text]. */
  key?: string;
  entries?: [string, string][];
  /** Status bar: S, W, E, A, I or empty. */
  messageType?: string;
  /** Table control. */
  rowCount?: number | null;
  visibleRowCount?: number | null;
  /** Table control: the row its first line shows (its scrollbar's position). */
  firstRow?: number;
  columns?: string[];
  /** User area that scrolls (a classic list): its vertical scrollbar. */
  scroll?: { position: number; maximum: number; pageSize: number };
  /** Menu bar: the menus' names. */
  menus?: string[];
  /** GuiShell: GridView, Tree, TextEdit, Toolbar, HTMLViewer, ... */
  sub?: string;
  /** `rows` are the rows from `first` on (the first row the grid shows; 0 when absent). */
  grid?: { cols: string[]; titles: string[]; rowCount: number; rows: string[][]; first?: number };
  /** `nodes` are the nodes on show from the `first` one on (0 when absent), up to the host's limit. */
  tree?: { shown: number; headers: string[]; nodes: TreeNode[]; first?: number };
  /** A toolbar's buttons; `type` as SAP GUI names it: Button, Menu, ButtonAndMenu, ... */
  buttons?: { id: string; text: string; tip: string; type?: string }[];
  /** A shell that could not be read. */
  error?: string;
}

export interface TreeNode {
  /** As SAP GUI holds it, often padded with spaces. */
  key: string;
  depth: number;
  text: string;
  /** Texts of the item columns of a column tree; null for a simple tree. */
  items: string[] | null;
  folder?: boolean;
  expanded?: boolean;
}

export interface WindowFacts {
  id: string;
  title: string;
  /** Every control of the window, the window first, in screen order. */
  controls: Control[];
}

export interface Screen {
  transaction: string;
  program: string;
  screen: string;
  system?: string;
  client?: string;
  /** The window that has the focus: the topmost popup, or "wnd[0]". */
  activeWindow?: string;
  /** Id of the control that has the keyboard focus (the active window's GuiFocus), when SAP GUI gives one. */
  focus?: string;
  /** Logon language of the session (Info.Language), e.g. "EN". */
  language?: string;
  windows: WindowFacts[];
}

export interface SessionFacts {
  /** "/app/con[0]/ses[1]" */
  id: string;
  busy: boolean;
  system?: string;
  client?: string;
  user?: string;
  transaction?: string;
  program?: string;
  screen?: string;
  sessionNumber?: number;
  language?: string;
  activeWindow?: string;
  windows?: { id: string; title: string }[];
}

export interface SessionsFacts {
  /** Id of the session the user is in, or "". */
  active: string;
  connections: { id: string; description: string; disabledByServer: boolean; sessions: SessionFacts[] }[];
}

export interface DoctorLocal {
  /** PowerShell's language mode in the host: "FullLanguage" when nothing restricts it. */
  languageMode?: string;
  processes: string[];
  settings: Record<string, { value: number; where: string } | null>;
}

export interface DoctorEngine {
  engine: boolean;
  error?: string;
  connections: { description: string; disabledByServer: boolean; sessions: number }[];
}

/** The channel to the host: one request, one answer. */
export interface Transport {
  request<T>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Stops the host. A promise, when it waits for the process to end. */
  close(): void | Promise<void>;
}
