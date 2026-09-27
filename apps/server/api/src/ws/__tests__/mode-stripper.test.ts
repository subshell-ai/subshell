import { describe, expect, it } from "bun:test";
import { ModeStreamStripper, stripViewerModes } from "@/ws/mode-stripper.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
// The alternate-screen pair (with save/restore), the buffer-only pair, and the
// legacy xterm spelling. A viewer parked on the alt buffer has NO scrollback,
// so a toggle that reaches xterm costs the panel its wheel for its whole life
// (2026-09-27 operator report).
const ALT = "\x1b[?1049h";
const ALT_BACK = "\x1b[?1049l";
const ALT_NS = "\x1b[?1047h";
const ALT_NS_BACK = "\x1b[?1047l";
const ALT_OLD = "\x1b[?47h";
const ALT_OLD_BACK = "\x1b[?47l";

describe("stripViewerModes (stateless)", () => {
  // xterm 6 withholds painting while DEC 2026 is open; TUIs that leave the
  // update open until their next redraw (claude-code does) stall paint ~1s,
  // so the markers are removed before the frame reaches the client.
  it("removes begin and end markers, keeping the frame content", () => {
    expect(stripViewerModes(`${BSU}hello${ESU}`)).toBe("hello");
  });

  it("removes a dangling begin marker (the case that caused the 1s paint stall)", () => {
    expect(stripViewerModes(`\x1b[3Am${BSU}`)).toBe("\x1b[3Am");
  });

  it("leaves plain text that merely mentions 2026 untouched", () => {
    expect(stripViewerModes("error 2026h and 2026l codes")).toBe("error 2026h and 2026l codes");
  });

  it("is a no-op on strings without the private-mode introducer", () => {
    const s = "\x1b[1;32m ready";
    expect(stripViewerModes(s)).toBe(s);
  });

  it("removes every alternate-screen toggle, forward and back", () => {
    expect(stripViewerModes(`${ALT}body${ALT_BACK}`)).toBe("body");
    expect(stripViewerModes(`${ALT_NS}body${ALT_NS_BACK}`)).toBe("body");
    expect(stripViewerModes(`${ALT_OLD}body${ALT_OLD_BACK}`)).toBe("body");
  });

  it("removes a dangling alt-screen begin (the reported case: Ink startup, no matching end)", () => {
    expect(stripViewerModes(`\x1b[3Am${ALT}`)).toBe("\x1b[3Am");
  });

  it("strips a real-ish Ink startup frame down to its main-buffer payload", () => {
    expect(stripViewerModes(`${ALT}\x1b[?25l\x1b[H\x1b[2Jhello${ALT_BACK}`)).toBe("\x1b[?25l\x1b[H\x1b[2Jhello");
  });

  it("removes ?47h inside text that also carries ?1047h (the `?` adjacency rule)", () => {
    // `?47` is only a marker when the `?` sits directly against it, so the
    // per-marker split/join cannot miss or over-eat either spelling.
    expect(stripViewerModes(`${ALT_OLD}a${ALT_NS}b${ALT_OLD_BACK}`)).toBe("ab");
  });
});

describe("ModeStreamStripper (stateful across chunk boundaries)", () => {
  it("emits complete chunks unchanged (markers stripped inline)", () => {
    const s = new ModeStreamStripper();
    expect(s.push(`${BSU}hello${ESU}`)).toBe("hello");
    expect(s.push("world")).toBe("world");
  });

  it("strips a begin marker SPLIT across two chunks — the stateless strip misses this", () => {
    const s = new ModeStreamStripper();
    // Chunk 1 ends mid-marker (6 of 8 bytes): the tail must be held, not emitted.
    expect(s.push("frame\x1b[?202")).toBe("frame");
    // Chunk 2 completes the marker: the held prefix + "6h" vanish together.
    expect(s.push("6hmore")).toBe("more");
  });

  it("strips an end marker split across chunks the same way", () => {
    const s = new ModeStreamStripper();
    expect(s.push(`${BSU}tick\x1b[?2026`)).toBe("tick");
    expect(s.push("l tail")).toBe(" tail");
  });

  it("strips an alt-screen toggle SPLIT across two chunks", () => {
    const s = new ModeStreamStripper();
    // `?1049h` arrives as `?104` + `9h`: held, completed, gone.
    expect(s.push("\x1b[?104")).toBe("");
    expect(s.push("9hrest")).toBe("rest");
  });

  it("strips a legacy ?47h split across chunks", () => {
    const s = new ModeStreamStripper();
    expect(s.push("a\x1b[?4")).toBe("a");
    expect(s.push("7hb")).toBe("b");
  });

  it("strips alt-screen markers arriving whole", () => {
    const s = new ModeStreamStripper();
    expect(s.push(`${ALT}top${ALT_BACK}mid`)).toBe("topmid");
    expect(s.push(`tail${ALT_NS_BACK}`)).toBe("tail");
    expect(s.push(`${ALT_NS}${ALT_OLD}x${ALT_OLD_BACK}`)).toBe("x");
  });

  it("re-emits the false-positive ?10… hold once the mode turns out to be mouse tracking", () => {
    const s = new ModeStreamStripper();
    // `ESC [ ? 1 0` is a strict prefix of the ?1049/?1047 markers: held…
    expect(s.push("\x1b[?10")).toBe("");
    // …but `0h` completes `?100h` (mouse tracking), not alt screen: intact.
    expect(s.push("0h")).toBe("\x1b[?100h");
  });

  it("flushes a false-positive hold intact once the sequence turns out to be something else", () => {
    const s = new ModeStreamStripper();
    // `ESC [ ? 2` is a strict prefix of the sync marker — held…
    expect(s.push("a\x1b[?2")).toBe("a");
    // …but `5l` completes a cursor-HIDE instead: the held bytes re-emitted, nothing lost.
    expect(s.push("5l")).toBe("\x1b[?25l");
  });

  it("holds only a partial marker: a lone trailing ESC is held, then released", () => {
    const s = new ModeStreamStripper();
    expect(s.push("x\x1b")).toBe("x");
    expect(s.push("[0m")).toBe("\x1b[0m");
  });

  it("flush returns the held tail on stream end without duplicating it", () => {
    const s = new ModeStreamStripper();
    expect(s.push("y\x1b[?2026")).toBe("y");
    expect(s.flush()).toBe("\x1b[?2026");
    expect(s.flush()).toBe("");
  });

  it("flush holds the longest new marker prefix too (the 7-byte ?1049 half)", () => {
    const s = new ModeStreamStripper();
    expect(s.push("y\x1b[?1049")).toBe("y");
    expect(s.flush()).toBe("\x1b[?1049");
  });

  it("an empty push emits nothing and loses nothing", () => {
    const s = new ModeStreamStripper();
    expect(s.push("")).toBe("");
    expect(s.push("z")).toBe("z");
  });
});

describe("pass-through discipline (only the stripped modes are touched)", () => {
  // Modes the relay must forward byte-identical: bracketed paste (2004),
  // SGR mouse (1006), cursor visibility (25), 24-bit color (38;2), OSC title.
  const PASS = "\x1b[?2004h\x1b[?1006h\x1b[?25l\x1b[38;2;12;34;56mhello\x1b[0m\x1b]0;a title\x1b\\";

  it("stateless: unrelated modes survive exactly", () => {
    expect(stripViewerModes(PASS)).toBe(PASS);
  });

  it("stateful: unrelated modes survive exactly, with nothing left held", () => {
    const s = new ModeStreamStripper();
    expect(s.push(PASS)).toBe(PASS);
    expect(s.flush()).toBe("");
  });

  it("stateful: unrelated modes survive split across chunks", () => {
    const s = new ModeStreamStripper();
    // `ESC [ ? 2 0` is a strict prefix of ?2026: the bytes are held…
    expect(s.push("\x1b[?20")).toBe("");
    // …but `04h` proves it is bracketed paste ?2004, re-emitted byte-identical.
    expect(s.push("04hbody")).toBe("\x1b[?2004hbody");
  });
});
