import { describe, expect, test } from "bun:test";
import { banner } from "@/cli/banner.js";

/** Built from a string so the ESC byte never sits inside a regex literal. */
const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);
describe("boot banner", () => {
  test("the plain form carries NO escape codes", () => {
    // The load-bearing property, not a style preference: the plain form is
    // what reaches a systemd or launchd journal, and escape codes committed to
    // a journal are something an operator has to read around forever.
    expect(banner(false)).not.toMatch(ANSI);
  });
});
