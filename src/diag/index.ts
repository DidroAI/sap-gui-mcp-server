/**
 * Reading SAP GUI screens from the DIAG protocol: the traffic between SAP GUI
 * for Windows and the application server, without SAP GUI scripting.
 * Protocol, screen model and text view; no MCP surface here.
 */
export { DiagDecoder, pairLabels } from "./decoder.js";
export { isLzh, LzhError, lzhCompress, lzhDecompress } from "./lzh.js";
export { parseRfc, type RfcCall, type RfcField, type RfcTable, rfcFields } from "./rfc.js";
export type * from "./screen.js";
export { DAMAGED_NOTE, type DiagViewOptions, diagView, GREYED, menuView, statusLine, TYPED } from "./view.js";
export { type DiagItem, type DiagMessage, NiFramer, parseItems, parseMessage } from "./wire.js";
