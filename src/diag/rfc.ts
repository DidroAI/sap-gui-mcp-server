/**
 * RFC calls as they travel inside DIAG (RFC_TR items): the server calls
 * function modules of the SAP GUI front end (the control framework).
 *
 * The payload of a call is a list of fields, each
 *
 *   id 2, length 2 (big-endian), data, id 2 again
 *
 * and ends with ff ff. The ids used here: 0102 function name; 0201 name of
 * an import parameter, 0203 its value; 0205 name of an export parameter;
 * 0301 name of a table, 0302 its row length and row count (two uint32),
 * then its rows: one 0304 field per row, or 0305 fields of up to 250 bytes
 * that together hold `7b 02 ?? ea`, the compressed length (uint32) and one
 * LZH block with all rows.
 */
import { lzhDecompress } from "./lzh.js";

export interface RfcField {
  id: number;
  data: Buffer;
}

export interface RfcTable {
  name: string;
  rowLength: number;
  /** Row count the header announces. */
  count: number;
  rows: Buffer[];
  /** Why the rows could not be read, when they could not. */
  problem?: string;
}

export interface RfcCall {
  function: string;
  /** Import parameters by name. */
  params: Map<string, Buffer>;
  tables: Map<string, RfcTable>;
  problem?: string;
}

const F = { FUNCTION: 0x0102, PARAM_NAME: 0x0201, PARAM_VALUE: 0x0203, TABLE_NAME: 0x0301, TABLE_INFO: 0x0302, TABLE_ROW: 0x0304, TABLE_PACKED: 0x0305, END: 0xffff } as const;

/** The fields of a call. Stops at ff ff or where the bytes stop being fields. */
export function rfcFields(b: Buffer, start = 0): { fields: RfcField[]; end: number; complete: boolean } {
  const fields: RfcField[] = [];
  let i = start;
  while (i + 2 <= b.length) {
    const id = b.readUInt16BE(i);
    if (id === F.END) return { fields, end: i + 2, complete: true };
    if (i + 4 > b.length) break;
    const n = b.readUInt16BE(i + 2);
    if (i + 6 + n > b.length || b.readUInt16BE(i + 4 + n) !== id) return { fields, end: i, complete: false };
    fields.push({ id, data: b.subarray(i + 4, i + 4 + n) });
    i += 6 + n;
  }
  return { fields, end: i, complete: false };
}

function unpackRows(packed: Buffer, t: RfcTable): void {
  if (packed.length < 16 || packed[0] !== 0x7b) {
    t.problem = "packed table without its header";
    return;
  }
  const n = packed.readUInt32BE(4);
  let data: Buffer;
  try {
    data = lzhDecompress(packed.subarray(8, 8 + n));
  } catch (e) {
    t.problem = e instanceof Error ? e.message : String(e);
    return;
  }
  if (t.rowLength > 0) for (let i = 0; i + t.rowLength <= data.length; i += t.rowLength) t.rows.push(data.subarray(i, i + t.rowLength));
  else if (data.length) t.rows.push(data);
}

/** One RFC call from the payload of an RFC_TR item (or of several joined). Never throws. */
export function parseRfc(payload: Buffer): RfcCall {
  const call: RfcCall = { function: "", params: new Map(), tables: new Map() };
  const { fields, complete } = rfcFields(payload);
  if (!complete) call.problem = "RFC payload breaks off";
  let param: string | undefined;
  let table: RfcTable | undefined;
  let packed: Buffer[] = [];
  const closeTable = () => {
    if (table && packed.length) unpackRows(Buffer.concat(packed), table);
    packed = [];
  };
  for (const f of fields) {
    if (f.id === F.FUNCTION) call.function = f.data.toString("latin1");
    else if (f.id === F.PARAM_NAME) param = f.data.toString("latin1");
    else if (f.id === F.PARAM_VALUE && param !== undefined) {
      call.params.set(param, f.data);
      param = undefined;
    } else if (f.id === F.TABLE_NAME) {
      closeTable();
      table = { name: f.data.toString("latin1"), rowLength: 0, count: 0, rows: [] };
      call.tables.set(table.name, table);
    } else if (f.id === F.TABLE_INFO && table && f.data.length >= 8) {
      table.rowLength = f.data.readUInt32BE(0);
      table.count = f.data.readUInt32BE(4);
    } else if (f.id === F.TABLE_ROW && table) table.rows.push(f.data);
    else if (f.id === F.TABLE_PACKED && table) packed.push(f.data);
  }
  closeTable();
  return call;
}
