import { describe, expect, it } from "bun:test";
import { joinSelectionRows, type SelectionRow } from "@/lib/terminal-native-copy";

/**
 * Copy mode (issue 242) selects with the BROWSER's native selection, so
 * xterm's own copy handler — the one that joins soft-wrap seams — never
 * fires, and the clipboard used to get row-by-row DOM text: newlines
 * wherever LAYOUT broke a line, a URL in dead fragments, a command that
 * cannot be pasted. The rebuild happens at copy time from the buffer's
 * `isWrapped` facts; these tests pin the join itself. (The DOM slice that
 * feeds these rows, and the listener that writes the result, are exercised
 * against a real browser selection by the e2e copy specs.)
 */

const row = (text: string, wrapped = false): SelectionRow => ({ text, wrapped });

describe("joinSelectionRows", () => {
  it("joins continuation rows with NOTHING between them", () => {
    // A URL soft-wrapped across three rows is ONE line: the seams are
    // layout, not text.
    expect(
      joinSelectionRows([row("go https://ex.io/aaa"), row("a/bbbb/cccc/dddd", true), row("e/ffff tail", true)]),
    ).toBe("go https://ex.io/aaaa/bbbb/cccc/dddde/ffff tail");
  });

  it("keeps the newline where a row ended on a real line break", () => {
    expect(joinSelectionRows([row("first line\r"), row("second line"), row("third\r"), row("fourth")])).toBe(
      "first line\r\r\nsecond line\r\nthird\r\r\nfourth",
    );
  });

  it("a selection that is one row copies exactly that text", () => {
    expect(joinSelectionRows([row("https://ex.io/whole/line")])).toBe("https://ex.io/whole/line");
  });

  it("a continuation row whose selection is empty adds nothing", () => {
    // Dragging to the very end of a wrapping row can leave the next row in
    // the selection carrying no text; joining it must not invent a newline.
    expect(joinSelectionRows([row("abc"), row("", true), row("def", true)])).toBe("abcdef");
  });

  it("the first row's own wrap flag is ignored — its predecessor is not selected", () => {
    expect(joinSelectionRows([row("tail of a wrapped row", true), row("next prompt")])).toBe(
      "tail of a wrapped row\r\nnext prompt",
    );
  });

  it("CRLF is the default terminator; a caller may pick LF", () => {
    // CRLF is the terminal's own line ending and a CRLF-terminated command
    // pastes clean at a prompt. (xterm's own copy is CRLF on Windows and LF
    // elsewhere; the copy-mode surface has one answer rather than a platform
    // split, and the seam rule — nothing between continuation rows — is what
    // the desktop copy legs in the e2e specs compare against.)
    expect(joinSelectionRows([row("a"), row("b")])).toBe("a\r\nb");
    expect(joinSelectionRows([row("a"), row("b")], "\n")).toBe("a\nb");
  });

  it("an empty selection yields the empty string", () => {
    expect(joinSelectionRows([])).toBe("");
  });
});
