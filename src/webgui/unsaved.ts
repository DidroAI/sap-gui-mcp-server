/**
 * What the agent typed into a transaction and SAP has not confirmed saving.
 *
 * `/n` and `/n<transaction>` leave a transaction at once: SAP asks nothing,
 * and input that was not saved is gone. The server cannot know what SAP
 * holds unsaved, but it knows what it typed itself: the inputs made in the
 * transaction since the last success message of the status bar (a save
 * answers with one). When the agent leaves with some, the answer says so.
 * A count, not a proof: a success message that was not a save resets it too,
 * so the note can be missing; it is never said for input the agent did not make.
 */
export class Unsaved {
  private transaction = "";
  private inputs = 0;
  private success = "";

  /** A view of the screen was read: another transaction, or a new success message, starts the count again. */
  seen(view: string): void {
    const transaction = /^TRANSACTION (\S*)/.exec(view)?.[1] ?? "";
    const success = /^(?:wnd\[0\]\/)?sbar {2}status {2}S: (.*)$/m.exec(view)?.[1] ?? "";
    if (transaction !== this.transaction || (success && success !== this.success)) this.inputs = 0;
    this.transaction = transaction;
    this.success = success;
  }

  /** The agent changed a value on the screen (typed into a field, set a checkbox, chose a dropdown entry). */
  typed(): void {
    this.inputs++;
  }

  /**
   * The transaction was left by a command: what to say about the inputs
   * that were not saved, or undefined when the agent made none. The count
   * starts again.
   */
  left(): string | undefined {
    const n = this.inputs;
    this.inputs = 0;
    if (!n || !this.transaction) return undefined;
    return `SAP left ${this.transaction} without asking: the ${n === 1 ? "value" : `${n} values`} set there since its last success message ${n === 1 ? "is" : "are"} lost unless saved before.`;
  }
}
