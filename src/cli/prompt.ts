/**
 * A small multi-select for the terminal (setup's agent picker): ↑/↓ move, space ticks, a ticks
 * all or none, Enter confirms, Esc or Ctrl+C cancels. The key handling is a pure function, so it
 * is tested without a terminal.
 */
import { emitKeypressEvents } from "node:readline";

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export interface PickState {
  cursor: number;
  checked: boolean[];
}

export type Key = { name?: string | undefined; ctrl?: boolean | undefined; sequence?: string | undefined };

/** The next state for a key, or "done" / "cancel". */
export function pickKey(state: PickState, key: Key): PickState | "done" | "cancel" {
  const n = state.checked.length;
  if ((key.ctrl && key.name === "c") || key.name === "escape") return "cancel";
  if (key.name === "return" || key.name === "enter") return "done";
  if (key.name === "up" || key.name === "k") return { ...state, cursor: (state.cursor - 1 + n) % n };
  if (key.name === "down" || key.name === "j" || key.name === "tab") return { ...state, cursor: (state.cursor + 1) % n };
  if (key.name === "space") return { ...state, checked: state.checked.map((c, i) => (i === state.cursor ? !c : c)) };
  if (key.name === "a") {
    const all = state.checked.every(Boolean);
    return { ...state, checked: state.checked.map(() => !all) };
  }
  return state;
}

export function renderPick(title: string, choices: Choice[], state: PickState): string[] {
  return [
    `${title}  (↑/↓ move, space select, a all, Enter confirm)`,
    ...choices.map((c, i) => `${i === state.cursor ? "❯" : " "} ${state.checked[i] ? "◉" : "◯"} ${c.label}${c.hint ? `  ${c.hint}` : ""}`),
  ];
}

/** Asks in the terminal; resolves to the values ticked, or undefined when cancelled. */
export function multiSelect(title: string, choices: Choice[], initial: string[], io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input: process.stdin, output: process.stdout }): Promise<string[] | undefined> {
  const { input, output } = io;
  let state: PickState = { cursor: 0, checked: choices.map((c) => initial.includes(c.value)) };
  let drawn = 0;
  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = renderPick(title, choices, state);
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  return new Promise((done) => {
    emitKeypressEvents(input);
    const raw = input.isTTY ? input.isRaw : false;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    const finish = (value: string[] | undefined) => {
      input.off("keypress", onKey);
      if (input.isTTY) input.setRawMode(raw);
      input.pause();
      output.write("\x1b[?25h");
      done(value);
    };
    const onKey = (_: string, key: Key) => {
      const next = pickKey(state, key ?? {});
      if (next === "cancel") return finish(undefined);
      if (next === "done") return finish(choices.filter((_, i) => state.checked[i]).map((c) => c.value));
      state = next;
      draw();
    };
    input.on("keypress", onKey);
    draw();
  });
}
