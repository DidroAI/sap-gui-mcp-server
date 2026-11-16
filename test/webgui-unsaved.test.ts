import { describe, expect, test } from "bun:test";
import { Unsaved } from "../src/webgui/unsaved.js";

const view = (transaction: string, status = "") => [`TRANSACTION ${transaction}  PROGRAM ZPROG  SCREEN 100`, 'WINDOW wnd[0]  "Synthetic"', ...(status ? [`wnd[0]/sbar  status  ${status}`] : [])].join("\n");

describe("input the agent made and a command drops", () => {
  test("leaving a transaction after typing says how many values are lost unless saved", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    u.typed();
    u.seen(view("ZT02"));
    u.typed();
    expect(u.left()).toBe("SAP left ZT02 without asking: the 2 values set there since its last success message are lost unless saved before.");
    // Said once.
    expect(u.left()).toBeUndefined();
  });

  test("nothing is said when the agent typed nothing, or SAP answered with a success message since", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    expect(u.left()).toBeUndefined();
    u.typed();
    u.seen(view("ZT02", "S: Order 1 has been saved"));
    expect(u.left()).toBeUndefined();
    // The same success message still on the screen does not hide what is typed after it.
    u.typed();
    u.seen(view("ZT02", "S: Order 1 has been saved"));
    expect(u.left()).toBe("SAP left ZT02 without asking: the value set there since its last success message is lost unless saved before.");
  });

  test("an error or a warning does not count as saved; another transaction starts the count again", () => {
    const u = new Unsaved();
    u.seen(view("ZT02"));
    u.typed();
    u.seen(view("ZT02", "E: Fill out all required entry fields"));
    u.seen(view("ZT03"));
    expect(u.left()).toBeUndefined();
    u.typed();
    u.seen(view("ZT03", "W: Check the date"));
    expect(u.left()).toContain("SAP left ZT03 without asking");
  });
});
