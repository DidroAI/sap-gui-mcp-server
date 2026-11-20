/**
 * Assertions that wait: each re-reads the screen until it holds or its
 * timeout ends (default: the session's `timeout`, 5 s), as Playwright's
 * web-first assertions do. A plain value gets plain, immediate matchers.
 *
 *   await expect(sap.field("VBAK-NETWR")).toHaveValue("100.00");
 *   await expect(sap.field("VBAK-VBELN")).not.toBeEditable();
 *   await expect(sap.status()).toBeSuccess();
 *   await expect(sap.status()).toContainText("saved");
 *   await expect(sap.grid("cntlGRID1/shellcont/shell")).toHaveRowCount(52);
 *   await expect(sap).toHaveTransaction("VA03");
 *   expect(await sap.field("X").value()).toBe("1");
 */
import { ControlLocator, type ControlState, GridLocator, type GridState, StatusLocator, type StatusState } from "./locators.js";
import { Sap } from "./session.js";

export class ExpectError extends Error {
  override name = "ExpectError";
}

export interface ExpectOptions {
  timeout?: number;
}

type Text = string | RegExp;
const fits = (actual: string, want: Text, whole: boolean) => (typeof want === "string" ? (whole ? actual.trim() === want.trim() : actual.includes(want)) : want.test(actual));
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 300 ? `${v.slice(0, 300)}...` : v) : String(v));

/** Polls `read` until `test` holds (or, negated, stops holding), then passes; else throws with the last reading. */
async function poll<T>(what: string, negate: boolean, timeout: number, read: () => Promise<T>, test: (v: T) => boolean, describe: (v: T) => string): Promise<void> {
  const until = Date.now() + timeout;
  let last: T | undefined;
  let error: unknown;
  for (;;) {
    try {
      last = await read();
      error = undefined;
      if (test(last) !== negate) return;
    } catch (e) {
      error = e;
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const got = error ? `reading it failed: ${(error as Error).message}` : last !== undefined ? describe(last) : "nothing was read";
  throw new ExpectError(`expect(${what})${negate ? ".not" : ""}: ${got} (waited ${timeout} ms)`);
}

class ControlAssertions {
  constructor(
    private l: ControlLocator,
    private negate: boolean,
    private timeout: number,
  ) {}
  get not(): ControlAssertions {
    return new ControlAssertions(this.l, !this.negate, this.timeout);
  }
  private check(name: string, test: (s: ControlState) => boolean, describe: (s: ControlState) => string, o?: ExpectOptions) {
    return poll(`${this.l}).${name}`, this.negate, o?.timeout ?? this.timeout, () => this.l.state(), test, (s) => (s.found ? describe(s) : "it is not on the screen"));
  }
  toHaveValue(v: Text, o?: ExpectOptions) {
    return this.check(`toHaveValue(${show(v)})`, (s) => s.found && fits(s.value ?? "", v, true), (s) => `the value is ${show(s.value)}`, o);
  }
  toContainValue(v: string, o?: ExpectOptions) {
    return this.check(`toContainValue(${show(v)})`, (s) => s.found && (s.value ?? "").includes(v), (s) => `the value is ${show(s.value)}`, o);
  }
  toBeEmpty(o?: ExpectOptions) {
    return this.check("toBeEmpty()", (s) => s.found && !(s.value ?? "").trim(), (s) => `the value is ${show(s.value)}`, o);
  }
  toBeEditable(o?: ExpectOptions) {
    return this.check("toBeEditable()", (s) => s.found && s.editable === true, (s) => (s.editable === undefined ? "the view does not say whether it is editable" : s.editable ? "it is editable" : "it is read-only"), o);
  }
  toBeReadOnly(o?: ExpectOptions) {
    return this.check("toBeReadOnly()", (s) => s.found && s.editable === false, (s) => (s.editable ? "it is editable" : "the view does not say it is read-only"), o);
  }
  toBeVisible(o?: ExpectOptions) {
    return this.check("toBeVisible()", (s) => s.found, () => "it is on the screen", o);
  }
  toBeChecked(o?: ExpectOptions) {
    return this.check("toBeChecked()", (s) => s.found && s.value === "true", (s) => `it is ${s.value === "true" ? "checked" : "not checked"}`, o);
  }
  toHaveLabel(v: Text, o?: ExpectOptions) {
    return this.check(`toHaveLabel(${show(v)})`, (s) => s.found && fits(s.label ?? "", v, true), (s) => `the label is ${show(s.label)}`, o);
  }
}

class StatusAssertions {
  constructor(
    private l: StatusLocator,
    private negate: boolean,
    private timeout: number,
  ) {}
  get not(): StatusAssertions {
    return new StatusAssertions(this.l, !this.negate, this.timeout);
  }
  private check(name: string, test: (s: StatusState) => boolean, o?: ExpectOptions) {
    return poll(`status bar).${name}`, this.negate, o?.timeout ?? this.timeout, () => this.l.state(), test, (s) => `the status bar is ${s.type ? `${s.type}: ` : ""}${show(s.text)}`);
  }
  toHaveText(v: Text, o?: ExpectOptions) {
    return this.check(`toHaveText(${show(v)})`, (s) => fits(s.text, v, true), o);
  }
  toContainText(v: string, o?: ExpectOptions) {
    return this.check(`toContainText(${show(v)})`, (s) => s.text.includes(v), o);
  }
  /** S: success. */
  toBeSuccess(o?: ExpectOptions) {
    return this.check("toBeSuccess()", (s) => s.type === "S", o);
  }
  /** E or A. */
  toBeError(o?: ExpectOptions) {
    return this.check("toBeError()", (s) => s.type === "E" || s.type === "A", o);
  }
  toHaveType(t: "S" | "I" | "W" | "E" | "A", o?: ExpectOptions) {
    return this.check(`toHaveType(${show(t)})`, (s) => s.type === t, o);
  }
  /** No message at all. */
  toBeEmpty(o?: ExpectOptions) {
    return this.check("toBeEmpty()", (s) => !s.text.trim(), o);
  }
}

class GridAssertions {
  constructor(
    private l: GridLocator,
    private negate: boolean,
    private timeout: number,
  ) {}
  get not(): GridAssertions {
    return new GridAssertions(this.l, !this.negate, this.timeout);
  }
  private check(name: string, test: (s: GridState) => boolean, describe: (s: GridState) => string, o?: ExpectOptions, range?: { from: number; to: number }) {
    return poll(`${this.l}).${name}`, this.negate, o?.timeout ?? this.timeout, () => this.l.state(range), (s) => s.found && test(s), (s) => (s.found ? describe(s) : "it is not on the screen"));
  }
  toHaveRowCount(n: number, o?: ExpectOptions) {
    return this.check(`toHaveRowCount(${n})`, (s) => (s.total ?? s.rows.length) === n, (s) => `it has ${s.total ?? s.rows.length} rows`, o);
  }
  /** Some row read (on screen, or in `rows`) contains the text. */
  toContainText(v: Text, o?: ExpectOptions & { rows?: { from: number; to: number } }) {
    return this.check(`toContainText(${show(v)})`, (s) => s.rows.some((r) => fits(r.text, v, false)), (s) => `no row read holds it (${s.rows.length} rows read)`, o, o?.rows);
  }
  toBeVisible(o?: ExpectOptions) {
    return this.check("toBeVisible()", () => true, () => "it is on the screen", o);
  }
}

class SessionAssertions {
  constructor(
    private sap: Sap,
    private negate: boolean,
    private timeout: number,
  ) {}
  get not(): SessionAssertions {
    return new SessionAssertions(this.sap, !this.negate, this.timeout);
  }
  private check(name: string, test: (s: Awaited<ReturnType<Sap["screen"]>>) => boolean, describe: (s: Awaited<ReturnType<Sap["screen"]>>) => string, o?: ExpectOptions) {
    return poll(`sap).${name}`, this.negate, o?.timeout ?? this.timeout, () => this.sap.screen(), test, describe);
  }
  toHaveTransaction(t: string, o?: ExpectOptions) {
    return this.check(`toHaveTransaction(${show(t)})`, (s) => (s.transaction ?? "").toUpperCase() === t.toUpperCase(), (s) => `the transaction is ${show(s.transaction)}`, o);
  }
  toHaveTitle(v: Text, o?: ExpectOptions) {
    return this.check(`toHaveTitle(${show(v)})`, (s) => fits(s.title ?? "", v, true), (s) => `the title is ${show(s.title)}`, o);
  }
  /** program and/or dynpro number, e.g. { program: "SAPMV45A", screen: "4001" }. */
  toBeOnScreen(want: { program?: string; screen?: string }, o?: ExpectOptions) {
    return this.check(
      `toBeOnScreen(${JSON.stringify(want)})`,
      (s) => (!want.program || s.program === want.program) && (!want.screen || s.screen === want.screen),
      (s) => `the screen is ${s.program ?? "?"}/${s.screen ?? "?"}`,
      o,
    );
  }
  /** The screen's text (the full view) holds this. */
  toContainText(v: Text, o?: ExpectOptions) {
    return this.check(`toContainText(${show(v)})`, (s) => fits(s.text, v, false), () => "the screen does not hold it", o);
  }
}

class ValueAssertions {
  constructor(
    private v: unknown,
    private negate: boolean,
  ) {}
  get not(): ValueAssertions {
    return new ValueAssertions(this.v, !this.negate);
  }
  private check(name: string, ok: boolean): void {
    if (ok === this.negate) throw new ExpectError(`expect(${show(this.v)})${this.negate ? ".not" : ""}.${name} failed`);
  }
  toBe(want: unknown) {
    this.check(`toBe(${show(want)})`, Object.is(this.v, want));
  }
  toEqual(want: unknown) {
    this.check(`toEqual(${show(JSON.stringify(want))})`, JSON.stringify(this.v) === JSON.stringify(want));
  }
  toContain(want: string) {
    this.check(`toContain(${show(want)})`, typeof this.v === "string" ? this.v.includes(want) : Array.isArray(this.v) && this.v.includes(want));
  }
  toMatch(re: RegExp) {
    this.check(`toMatch(${re})`, typeof this.v === "string" && re.test(this.v));
  }
  toBeTruthy() {
    this.check("toBeTruthy()", !!this.v);
  }
  toBeGreaterThan(n: number) {
    this.check(`toBeGreaterThan(${n})`, typeof this.v === "number" && this.v > n);
  }
  toBeLessThan(n: number) {
    this.check(`toBeLessThan(${n})`, typeof this.v === "number" && this.v < n);
  }
}

export function expect(subject: ControlLocator, options?: ExpectOptions): ControlAssertions;
export function expect(subject: StatusLocator, options?: ExpectOptions): StatusAssertions;
export function expect(subject: GridLocator, options?: ExpectOptions): GridAssertions;
export function expect(subject: Sap, options?: ExpectOptions): SessionAssertions;
export function expect(subject: unknown): ValueAssertions;
export function expect(subject: unknown, options?: ExpectOptions): ControlAssertions | StatusAssertions | GridAssertions | SessionAssertions | ValueAssertions {
  if (subject instanceof ControlLocator) return new ControlAssertions(subject, false, options?.timeout ?? subject.sap.timeout);
  if (subject instanceof StatusLocator) return new StatusAssertions(subject, false, options?.timeout ?? subject.sap.timeout);
  if (subject instanceof GridLocator) return new GridAssertions(subject, false, options?.timeout ?? subject.sap.timeout);
  if (subject instanceof Sap) return new SessionAssertions(subject, false, options?.timeout ?? subject.timeout);
  return new ValueAssertions(subject, false);
}
