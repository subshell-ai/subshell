import { describe, expect, test } from "bun:test";
import { banner } from "@/banner.js";

/** Built from a string so the ESC byte never sits inside a regex literal. */
const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);
/** The narrowest terminal anyone still uses. */
const MIN_TERMINAL_COLS = 80;

const lines = () => banner(false).split("\n");

describe("boot banner", () => {
  test("the plain form carries NO escape codes", () => {
    // The load-bearing property, not a style preference: the plain form is
    // what reaches a systemd or launchd journal, and escape codes committed to
    // a journal are something an operator has to read around forever.
    expect(banner(false)).not.toMatch(ANSI);
  });

  test("colour changes the ink, never the drawing", () => {
    expect(banner(true)).toMatch(ANSI);
    // Strip the escapes and the two forms are identical, so a palette edit can
    // never silently reflow the art.
    expect(banner(true).replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "")).toBe(banner(false));
  });

  test("fits an 80-column terminal", () => {
    // A banner that WRAPS is worse than no banner — the letterforms shear and
    // the boot log opens looking corrupted. Measured on the plain form; the
    // colour form's escape codes occupy no cells.
    expect(Math.max(...lines().map((l) => l.length))).toBeLessThanOrEqual(MIN_TERMINAL_COLS);
  });

  test("is drawn only from #, + and spaces", () => {
    // Deliberately plain ASCII: no block elements, no box drawing. Those
    // depend on the font rendering them at exactly the cell box, and the seams
    // show in a lot of terminals.
    expect(banner(false).replace(/[#+ \n]/g, "")).toBe("");
  });

  test("the character split agrees with the COLOUR split", () => {
    // Two independent constants describe the same boundary: `#` vs `+` in the
    // art, and SUB_END in the painter. If they drift, the wordmark gets a
    // `sub`-coloured `+` — legible, subtly wrong, and invisible to every other
    // test here. `#` must live entirely left of the boundary and `+` right.
    const SUB_END = 38;
    for (const line of lines()) {
      expect(line.slice(0, SUB_END)).not.toContain("+");
      expect(line.slice(SUB_END)).not.toContain("#");
    }
  });

  test("has no blank first or last line, and no trailing newline", () => {
    const rows = lines();
    expect(rows[0]?.trim()).not.toBe("");
    expect(rows[rows.length - 1]?.trim()).not.toBe("");
    expect(banner(false).endsWith("\n")).toBe(false);
  });
});
