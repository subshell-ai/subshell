import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@internal/backend-errors";
import { computeActivity, PREVIEW_LINES, screenTail } from "@/services/subshell-manager.service.js";

describe("subshell activity heuristics", () => {
  const now = 1_000_000;
  it("terminated when status is not running", () => {
    expect(computeActivity(null, "terminated", now)).toBe("terminated");
  });
  it("idle when no output for 60s", () => {
    expect(computeActivity(new Date(now - 61_000).toISOString(), "running", now)).toBe("idle");
  });
  it("active when output within 60s", () => {
    expect(computeActivity(new Date(now - 5_000).toISOString(), "running", now)).toBe("active");
  });
  it("active when no output yet but running (just started)", () => {
    expect(computeActivity(null, "running", now)).toBe("active");
  });
  it("strips ANSI escape sequences", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
});

describe("screenTail", () => {
  it("takes the bottom lines, where a terminal puts what just happened", () => {
    expect(screenTail("one\ntwo\nthree\nfour", 2)).toEqual(["three", "four"]);
  });

  it("drops the blank rows a pane is padded with, so content survives a short tail", () => {
    // A captured pane is always its full height; without this the two real
    // lines would be pushed out by padding.
    expect(screenTail("one\ntwo\n\n\n\n", 2)).toEqual(["one", "two"]);
  });

  it("drops the blank run above the content, so a quiet screen doesn't render as an empty card", () => {
    expect(screenTail("\n\n\n\n\nprompt", 4)).toEqual(["prompt"]);
  });

  it("treats a row of styling escapes and spaces as blank", () => {
    expect(screenTail("\x1b[39m   \nreal", 4)).toEqual(["real"]);
  });

  it("keeps a single blank between content, so paragraph breaks survive", () => {
    expect(screenTail("one\n\ntwo", 3)).toEqual(["one", "", "two"]);
  });

  it("collapses the empty middle of a screen so the content is reachable in a short window", () => {
    // The shape this exists for: a harness draws its conversation at the top
    // and its input box at the bottom, with a field of blanks between. Without
    // collapsing, a 4-line window would be all gap and box.
    const screen = ["answer", "", "", "", "", "", "", "", "----", "> ", "----"].join("\n");
    // Eight blank rows collapse to one, so a 5-line window reaches "answer".
    // Uncollapsed, those same 5 lines would have been four blanks and a rule.
    expect(screenTail(screen, 5)).toEqual(["answer", "", "----", "> ", "----"]);
  });

  it("keeps styling escapes intact", () => {
    // The preview is rendered with colour, so unlike the log tail this
    // replaced, escapes must survive.
    expect(screenTail("\x1b[31mred\x1b[0m", 1)).toEqual(["\x1b[31mred\x1b[0m"]);
  });

  it("treats a screen of only blank rows as empty", () => {
    expect(screenTail("\n\n\n", 5)).toEqual([]);
  });

  it("returns everything when the screen is shorter than the limit", () => {
    expect(screenTail("one\ntwo", PREVIEW_LINES)).toEqual(["one", "two"]);
  });
});
