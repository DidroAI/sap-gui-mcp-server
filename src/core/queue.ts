/**
 * One call at a time per SAP session.
 *
 * A session is one screen, one keyboard and one mouse: two calls that run
 * at once type into each other's fields and press keys on each other's
 * screens (measured in Web GUI: a `set` sent without waiting for it, then
 * Enter, was wrong 10 times out of 10). The server therefore runs the calls
 * that touch a session in the order they arrived, each after the one before
 * has answered. Reads wait too: a look during an action would show the
 * screen from before it.
 */

export interface Turn {
  /** How long the call waited for the calls before it, in milliseconds. */
  waited: number;
  /** What ran before it, when it waited: the label of the call it waited for last. */
  after: string | undefined;
}

export class SessionQueue {
  private tails = new Map<string, { done: Promise<void>; label: string }>();

  /** Runs `f` once every call queued before it on `key` has ended (answered or failed). */
  async run<T>(key: string, label: string, f: (turn: Turn) => Promise<T>): Promise<T> {
    const before = this.tails.get(key);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = { done: (before?.done ?? Promise.resolve()).then(() => mine), label };
    this.tails.set(key, tail);
    const t0 = Date.now();
    if (before) await before.done;
    try {
      return await f({ waited: Date.now() - t0, after: before?.label });
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Is a call running or waiting on `key`? */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** The line a call that had to wait starts with; empty when it did not wait long enough to matter. */
export function waitedLine(turn: Turn): string {
  if (turn.waited < 100) return "";
  return `(This call waited ${(turn.waited / 1000).toFixed(1)} s for the call before it on this session${turn.after ? ` (${turn.after})` : ""}: calls on one session run one after the other.)`;
}
