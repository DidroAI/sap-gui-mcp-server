/**
 * What the agent typed into a transaction and SAP has not confirmed saving.
 *
 * `/n` and `/n<transaction>` leave a transaction at once: SAP asks nothing,
 * and input that was not saved is gone. The server cannot know what SAP
 * holds unsaved, but it knows what it typed itself: the inputs made in the
 * transaction, on screens that can save, since the last success message of
 * the status bar (a save answers with one). When the agent leaves with some, the answer says so.
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

  /**
   * The agent changed a value on the screen (typed into a field, set a
   * checkbox, chose a dropdown entry); `view` is the screen it was set on.
   * It counts where SAP can save: the system toolbar of the main window has
   * Save (btn[11]). A display transaction and the initial screen that asks
   * for a document number have none, or show it greyed out, so nothing typed
   * there can be lost. On a report's selection screen that button saves a
   * variant, and what is typed are selection criteria, not data; so on any
   * screen with Execute (F8) in its application toolbar.
   */
  typed(view: string): void {
    const save = /^wnd\[0\]\/tbar\[0\]\/btn\[11\] {2}button.*$/m.exec(view)?.[0];
    // Save greyed out: nothing on this screen can be saved.
    if (!save || /\(greyed out/.test(save)) return;
    // A screen that runs a search or a report (Execute, F8, in the application toolbar: SE16N's table and its
    // maximum number of hits): what is typed are criteria, not data (Astra's review, 2026-11-23).
    if (/^wnd\[0\]\/tbar\[1\]\/btn\[8\] {2}button {2}[^\n]*\(F8\)/m.test(view)) return;
    if (/%_APP_%-/.test(view) || /^TRANSACTION .* {2}SCREEN 1000(?: |$)/m.test(view)) return;
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
