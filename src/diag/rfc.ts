/**
 * RFC calls as they travel inside DIAG (the RFC items, id 08): the server
 * calls function modules of the SAP GUI front end (the control framework),
 * and SAP GUI answers.
 *
 * The payload of a call is a list of fields, each
 *
 *   id 2, length 2 (big-endian), data, id 2 again
 *
 * and ends with ff ff (all 73 calls and answers of the captures do). What
 * each id read here holds, as the captured calls show it:
 *
 *   0102  the function's name ("OLE_FLUSH_CALL"); only in calls, not in answers
 *   0201  a parameter's name, followed by 0203, its value
 *   0301  a table's name, followed by 0302: row length and row count (uint32 each)
 *   0304  one row of that table, as many as the count; the server's rows have
 *         the row length, some of SAP GUI's are a single byte
 *   0305  up to 250 bytes of the table's rows, packed: the parts joined are
 *         7b 02 ?? ea, the packed length (uint32), and one LZH block that
 *         unpacks to row length x row count bytes (120 of 120 tables);
 *         an empty 0306 follows the last part
 *
 * The other ids (a header of about twenty fields before the function name:
 * host names, release, user, client) are not read.
 *
 * Example (synthetic): 01 02 00 04 "Z_GO" 01 02 | ff ff is a call of Z_GO
 * without parameters.
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

/** Field ids, named by what their data is. */
const FIELD = { functionName: 0x0102, paramName: 0x0201, paramValue: 0x0203, tableName: 0x0301, tableShape: 0x0302, tableRow: 0x0304, tablePacked: 0x0305, end: 0xffff } as const;

/** The fields of a call. Stops at ff ff or where the bytes stop being fields. */
export function rfcFields(b: Buffer, start = 0): { fields: RfcField[]; end: number; complete: boolean } {
  const fields: RfcField[] = [];
  let i = start;
  while (i + 2 <= b.length) {
    const id = b.readUInt16BE(i);
    if (id === FIELD.end) return { fields, end: i + 2, complete: true };
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

/** One RFC call from the payload of an RFC item (or of several parts joined). Never throws. */
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
    if (f.id === FIELD.functionName) call.function = f.data.toString("latin1");
    else if (f.id === FIELD.paramName) param = f.data.toString("latin1");
    else if (f.id === FIELD.paramValue && param !== undefined) {
      call.params.set(param, f.data);
      param = undefined;
    } else if (f.id === FIELD.tableName) {
      closeTable();
      table = { name: f.data.toString("latin1"), rowLength: 0, count: 0, rows: [] };
      call.tables.set(table.name, table);
    } else if (f.id === FIELD.tableShape && table && f.data.length >= 8) {
      table.rowLength = f.data.readUInt32BE(0);
      table.count = f.data.readUInt32BE(4);
    } else if (f.id === FIELD.tableRow && table) table.rows.push(f.data);
    else if (f.id === FIELD.tablePacked && table) packed.push(f.data);
  }
  closeTable();
  return call;
}
