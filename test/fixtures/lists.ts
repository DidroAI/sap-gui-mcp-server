/**
 * Classic lists as SAP GUI and Web GUI showed them in the Haiku benchmark of
 * 2026-11-23, rebuilt from the tool outputs of the runs:
 *
 * - ME2L on S/4HANA (P2P-05): 47 lines below 3 title rows and a blank row
 *   (the lines start at screen row 5), 16 shown at a time. Read with title
 *   rows taken for lines, lines 16 to 20 (PO 4500001184) were skipped.
 * - FBL5N on ECC (REP-06): 56 lines below the customer header block (17
 *   rows), 13 shown while SAP GUI's page size says 13, then 12. At the end
 *   of the list the header area shows a part of the next page's header.
 *   Read with the header taken for lines, it said "rows 1 to 59 of 56",
 *   repeated the header and lost 17 of the 34 items.
 *
 * Lines the runs did not show (PO 4500001184, FBL5N items 13 to 29) are
 * made up in the same form. A line is "text {col} | text {col}", "" blank.
 */
import type { RowSource } from "../../src/core/rows.js";

export interface ListFixture {
  header: string;
  title: string;
  /** Title rows (screen rows above the first line). */
  titleRows: number;
  /** Rows shown below the title rows. */
  shown: number;
  /** The page size the reader reports, by read (SAP GUI's can be one off). */
  reported: (read: number) => number;
  /** The title area, by screen row, with the list scrolled to `first`. */
  titles: (first: number) => Map<number, string>;
  lines: string[];
  /** Web GUI says how many title rows the list has; SAP GUI does not. */
  webgui?: boolean;
}

const po = (num: string, date: string, item: string, plant: string, qty: string, unit: string, price: string, value: string, cur: string, invoiced = qty, invValue = value, pct = "100.00"): string[] => [
  `${num} {1} | NB {12} | 17300002 {17} | Domestic US Supplier 2 {28} | 001 {65} | ${date} {69}`,
  item,
  `${plant} | ${qty} {27} | ${unit} {45} | ${price} {50} | ${cur} {65} | 1 {71} | ${unit} {77}`,
  `Still to be delivered {6} | ${qty} {27} | ${unit} {45} | ${value} {48} | ${cur} {65} | 100.00 {70} | % {78}`,
  `Still to be invoiced {6} | ${invoiced} {27} | ${unit} {45} | ${invValue} {48} | ${cur} {65} | ${pct} {70} | % {78}`,
];

const ME2L_LINES: string[] = [
  "4500000028 {1} | NB {12} | 17300002 {17} | Domestic US Supplier 2 {28} | 001 {65} | 10/10/2017 {69}",
  "00010 {3} | TG0011 {9} | Trading Good 0011,PD {50} | L001 {71}",
  "1710 {9} | 10 {27} | PC {45} | 9.00 {50} | EUR {65} | 1 {71} | PC {77}",
  "In stockkeeping unit {6} | 10 {27} | PC {45} | 8.24 {50} | USD {65} | 1 {71} | PC {77}",
  "Still to be delivered {6} | 10 {27} | PC {45} | 90.00 {48} | EUR {65} | 100.00 {70} | % {78}",
  "Still to be invoiced {6} | 10 {27} | PC {45} | 90.00 {48} | EUR {65} | 100.00 {70} | % {78}",
  ...po("4500000613", "01/28/2020", "00010 {3} | RM233-1 {9} | RAW233-1, PD, KANBAN {50} | L002 {71}", "1710 {9} | 171C {14}", "2,000", "PC", "3.00", "6,000.00", "USD"),
  ...po("4500000614", "01/28/2020", "00010 {3} | RM233-4 {9} | RAW233-4,ND,KANBAN,s {50} | L002 {71}", "1710 {9} | 171B {14}", "910", "PC", "3.00", "2,730.00", "USD"),
  // Not shown by the run: the PO it lost (10 PC, the 3090 - 3080 of the answer).
  ...po("4500001184", "05/12/2021", "00010 {3} | RM233-2 {9} | RAW233-2,ND,KANBAN,s {50} | L002 {71}", "1710 {9} | 171E {14}", "10", "PC", "3.00", "30.00", "USD"),
  ...po("4500001264", "11/04/2021", "00010 {3} | TG0011 {9} | Trading Good 0011,PD {50} | L001 {71}", "1710 {9} | 171A {14}", "100", "PC", "50.00", "5,000.00", "USD"),
  ...po("4500001265", "11/17/2021", "00010 {3} | TG0011 {9} | Trading Good 0011,PD {50} | L001 {71}", "1710 {9}", "50", "PC", "70.00", "3,500.00", "USD"),
  ...po("4500001385", "10/29/2022", "00010 {3} | office supply {50} | YBMM00 {71}", "K {7} | 1710 {9}", "100", "EA", "100.00", "10,000.00", "USD"),
  ...po("4500001456", "11/11/2022", "00010 {3} | RM233-2 {9} | RAW233-2,ND,KANBAN,s {50} | L002 {71}", "1710 {9} | 171E {14}", "10", "PC", "3.00", "30.00", "USD"),
  ...po("4500001762", "11/06/2023", "00010 {3} | office supply {50} | YBMM00 {71}", "K {7} | 1710 {9}", "100", "EA", "100.00", "10,000.00", "USD", "99", "9,900.00", "99.00"),
  "",
];

const ME2L_TITLES = new Map([
  [1, "PO         Type Supplier   Name                                 PGp Order Date {1}"],
  [2, "Item  Material                                 Short Text         Mat. Group {1}"],
  [3, "D I A Plnt SLoc              Order Qty    Un       Net Price  Curr.   per Un {1}"],
]);

export const ME2L: ListFixture = {
  header: "TRANSACTION ME2L  PROGRAM SAPMSSY0  SCREEN 120",
  title: "Purchasing Documents per Supplier",
  titleRows: 5,
  shown: 16,
  reported: () => 16,
  titles: () => ME2L_TITLES,
  lines: ME2L_LINES,
};

const item = (type: string, doc: string, due: string, clear: string, amount: string, no: string) => `[ ] {1} | ${type} {11} | ${doc} {20} | ${due} {31} | ${clear} {42} | ${amount} {53} | EUR {72} | ${no} {78}`;

const FBL5N_ITEMS: string[] = [
  item("RV", "15.12.1997", "29.01.1998", "15.02.1998", "130.005,98", "100007678"),
  item("RV", "17.11.1997", "01.01.1998", "18.01.1998", "30.087,23", "100007664"),
  item("RV", "17.11.1997", "01.01.1998", "18.01.1998", "62.179,48", "100007654"),
  item("DZ", "23.12.1997", "23.12.1997", "23.12.1997", "28.482,03-", "1400002650"),
  item("RV", "22.10.1997", "06.12.1997", "23.12.1997", "28.482,03", "100007580"),
  item("DZ", "23.12.1997", "23.12.1997", "23.12.1997", "124.463,04-", "1400002645"),
  item("RV", "22.10.1997", "06.12.1997", "23.12.1997", "124.463,04", "100007574"),
  item("DZ", "16.11.1997", "16.11.1997", "16.11.1997", "136.377,39-", "1400002569"),
  item("RV", "15.09.1997", "30.10.1997", "16.11.1997", "136.377,39", "100007529"),
  item("DZ", "16.11.1997", "16.11.1997", "16.11.1997", "132.711,89-", "1400002564"),
  item("RV", "15.09.1997", "30.10.1997", "16.11.1997", "132.711,89", "100007524"),
  item("DZ", "18.10.1997", "18.10.1997", "18.10.1997", "10.410,87-", "1400002546"),
  item("RV", "15.08.1997", "29.09.1997", "18.10.1997", "10.410,87", "100007463"),
  // Items 13 to 29: not shown by the run (it skipped them), made up.
  ...Array.from({ length: 17 }, (_, i) => item(i % 2 ? "DZ" : "RV", "15.07.1997", "29.08.1997", "18.09.1997", `${1000 + i},00${i % 2 ? "-" : ""}`, `1000073${String(i).padStart(2, "0")}`)),
  item("DZ", "12.02.1997", "12.02.1997", "12.02.1997", "67.638,34-", "1400002496"),
  item("RV", "28.01.1997", "14.03.1997", "12.02.1997", "28.438,51", "100005834"),
  item("RV", "28.01.1997", "14.03.1997", "12.02.1997", "17.605,47", "100005833"),
  item("RV", "28.01.1997", "14.03.1997", "12.02.1997", "21.594,36", "100005832"),
];

const FBL5N_LINES: string[] = [
  ...FBL5N_ITEMS,
  "* {3} | 222.272,69 {53} | EUR {72}",
  "",
  "** {3} | Account 2004 {6} | 222.272,69 {53} | EUR {72}",
  "",
  "",
  // The header of the list's next page (the totals page), as lines of the list.
  "Customer {0} | * {26}",
  "Name {0} | * {26}",
  "Street {0} | * {26}",
  "City {0} | * {26} | * {62}",
  "TelephoneNumber {0} | * {26}",
  "",
  "Company Code {0} | * {26} | * {31}",
  "Customer user {0} | * {26}",
  "Act.clk tel.no. {0} | * {26}",
  "Clrk's internet {0} | * {26}",
  "Acct at cust. {0} | * {26}",
  "Payt Terms {0} | * {26} | * {31}",
  "Account memo {0} | * {26}",
  "",
  "Stat {6} | Type {11} | Doc. Date {20} | Net due dt {31} | Clearing {42} | Amt in loc.cur. {53} | LCurr {72} | DocumentNo {78}",
  "",
  "*** {3} | 222.272,69 {53} | EUR {72}",
];

const FBL5N_HEAD: [number, string][] = [
  [1, "Customer {0} | 2004 {26}"],
  [2, "Name {0} | SudaTech GmbH {26}"],
  [3, "Street {0} | Triberger Strasse 9 {26}"],
  [4, "City {0} | Stuttgart {26} | 70569 {62}"],
  [5, "TelephoneNumber {0} | +49 (711) 7992-00 {26}"],
  [7, "Company Code {0} | 1000 {26} | Best Run (do not change!) {31}"],
  [8, "Customer user {0}"],
  [9, "Act.clk tel.no. {0}"],
  [10, "Clrk's internet {0}"],
  [11, "Acct at cust. {0}"],
];

export const FBL5N: ListFixture = {
  header: "TRANSACTION FBL5N  PROGRAM SAPMSSY0  SCREEN 120",
  title: "Customer Line Item Display",
  titleRows: 17,
  shown: 13,
  reported: (read) => (read === 0 ? 13 : 12),
  titles: (first) =>
    first >= 40
      ? new Map([...FBL5N_HEAD, [13, "Customer {0} | * {26}"], [14, "Name {0} | * {26}"], [15, "Street {0} | * {26}"], [16, "City {0} | * {26} | * {62}"]])
      : new Map([
          ...FBL5N_HEAD,
          [12, "Payt Terms {0} | ZB01 {26} | 14 days 3%, 30/2%, 45 net {31}"],
          [13, "Account memo {0}"],
          [15, "Stat {6} | Type {11} | Doc. Date {20} | Net due dt {31} | Clearing {42} | Amt in loc.cur. {53} | LCurr {72} | DocumentNo {78}"],
        ]),
  lines: FBL5N_LINES,
};

/** The cells of a list line: "a {1} | b {12}" as the reader writes them, at screen row `r`. */
function cells(text: string, r: number): string[] {
  if (!text) return [];
  return text.split(" | ").map((cell) => {
    const m = /^(.*) \{(\d+)\}$/.exec(cell);
    return `wnd[0]/usr/lbl[${m?.[2] ?? 1},${r}]  label  ${m?.[1] ?? cell}`;
  });
}

/** The full view of the list scrolled to `first`, as the SAP GUI (or Web GUI) reader writes it. */
export function listView(f: ListFixture, first: number, read = 0): string {
  const total = f.lines.length;
  const visible = f.reported(read);
  const below = f.webgui ? `, below ${f.titleRows} title rows` : "";
  const out = [f.header, `WINDOW wnd[0]  "${f.title}"`, `wnd[0]/usr  list  ${total} rows (visible ${visible}${first ? `, first ${first}` : ""}${below}; scroll for the others)`];
  for (const [r, t] of [...f.titles(first)].sort((a, b) => a[0] - b[0])) out.push(...cells(t, r));
  for (let i = 0; i < f.shown && first + i < total; i++) out.push(...cells(f.lines[first + i] ?? "", f.titleRows + i));
  return out.join("\n");
}

/** A list the reader scrolls: SAP GUI keeps the scroll position between 0 and the last page. */
export function listSource(f: ListFixture): RowSource & { scrolls: number[] } {
  let first = 0;
  let reads = 0;
  const scrolls: number[] = [];
  return {
    scrolls,
    scrollTo: async (row) => {
      scrolls.push(row);
      first = Math.max(0, Math.min(row, f.lines.length - f.shown));
    },
    block: async () => {
      const v = listView(f, first, reads++);
      return { block: v, screen: v };
    },
  };
}
