import { describe, expect, it } from "bun:test";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/subshell-protocol";
import { isRepeatable, KEY_BAR_BUTTONS, KEY_BAR_EXTENDED, wrapPaste } from "@/lib/key-bar";

/** Byte-for-byte port of the web bar's table (spec §Screens "the web table ported byte-for-byte"; source apps/server/web/src/components/terminal-key-bar.tsx:15-33). */
const EXPECTED_MAIN: [string, string][] = [
  ["Esc", "\x1b"],
  ["^C", "\x03"],
  ["⇧Tab", "\x1b[Z"],
  ["Tab", "\t"],
  ["⏎", "\r"],
  ["⇧⏎", "\x1b\r"],
  ["/", "/"],
  ["←", "\x1b[D"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["→", "\x1b[C"],
];

describe("KEY_BAR_BUTTONS", () => {
  it("matches the web key bar byte-for-byte", () => {
    expect(KEY_BAR_BUTTONS.map((b) => [b.label, b.bytes])).toEqual(EXPECTED_MAIN);
  });

  it("has unique labels", () => {
    const labels = KEY_BAR_BUTTONS.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("KEY_BAR_EXTENDED", () => {
  it("sends plain Ctrl and CSI page sequences (the ⋯ page)", () => {
    expect(KEY_BAR_EXTENDED.map((b) => [b.label, b.bytes])).toEqual([
      ["^D", "\x04"],
      ["^L", "\x0c"],
      ["^R", "\x12"],
      ["PgUp", "\x1b[5~"],
      ["PgDn", "\x1b[6~"],
    ]);
  });
});

describe("isRepeatable", () => {
  it("repeats only the arrows (spec: press-repeat on arrows)", () => {
    for (const label of ["←", "↑", "↓", "→"]) expect(isRepeatable(label)).toBe(true);
    for (const label of ["Esc", "^C", "⏎", "^D", "PgUp"]) expect(isRepeatable(label)).toBe(false);
  });
});

describe("wrapPaste", () => {
  it("wraps once when bracketed, passes through otherwise", () => {
    expect(wrapPaste("/tmp/x", true)).toBe(`${BRACKETED_PASTE_START}/tmp/x${BRACKETED_PASTE_END}`);
    expect(wrapPaste("/tmp/x", false)).toBe("/tmp/x");
    expect(wrapPaste("", true)).toBe("");
    expect(wrapPaste("", false)).toBe("");
  });
});
