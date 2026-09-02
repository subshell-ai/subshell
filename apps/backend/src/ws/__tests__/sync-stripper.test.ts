import { describe, expect, it } from "bun:test";
import { SyncStreamStripper, stripSyncMarkers } from "@/ws/sync-stripper.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

describe("stripSyncMarkers (stateless)", () => {
  // xterm 6 withholds painting while DEC 2026 is open; TUIs that leave the
  // update open until their next redraw (claude-code does) stall paint ~1s,
  // so the markers are removed before the frame reaches the client.
  it("removes begin and end markers, keeping the frame content", () => {
    expect(stripSyncMarkers(`${BSU}hello${ESU}`)).toBe("hello");
  });

  it("removes a dangling begin marker (the case that caused the 1s paint stall)", () => {
    expect(stripSyncMarkers(`\x1b[3Am${BSU}`)).toBe("\x1b[3Am");
  });

  it("leaves plain text that merely mentions 2026 untouched", () => {
    expect(stripSyncMarkers("error 2026h and 2026l codes")).toBe("error 2026h and 2026l codes");
  });

  it("is a no-op on strings without the fast-path substring", () => {
    const s = "\x1b[1;32m ready";
    expect(stripSyncMarkers(s)).toBe(s);
  });
});

describe("SyncStreamStripper (stateful across chunk boundaries)", () => {
  it("emits complete chunks unchanged (markers stripped inline)", () => {
    const s = new SyncStreamStripper();
    expect(s.push(`${BSU}hello${ESU}`)).toBe("hello");
    expect(s.push("world")).toBe("world");
  });

  it("strips a begin marker SPLIT across two chunks — the stateless strip misses this", () => {
    const s = new SyncStreamStripper();
    // Chunk 1 ends mid-marker (7 of 9 bytes): the tail must be held, not emitted.
    expect(s.push("frame\x1b[?202")).toBe("frame");
    // Chunk 2 completes the marker: the held prefix + "h" vanish together.
    expect(s.push("6hmore")).toBe("more");
  });

  it("strips an end marker split across chunks the same way", () => {
    const s = new SyncStreamStripper();
    expect(s.push(`${BSU}tick\x1b[?2026`)).toBe("tick");
    expect(s.push("l tail")).toBe(" tail");
  });

  it("flushes a false-positive hold intact once the sequence turns out to be something else", () => {
    const s = new SyncStreamStripper();
    // `ESC [ ? 2` is a strict prefix of the sync marker — held…
    expect(s.push("a\x1b[?2")).toBe("a");
    // …but `5l` completes a cursor-HIDE instead: the held bytes re-emitted, nothing lost.
    expect(s.push("5l")).toBe("\x1b[?25l");
  });

  it("holds only a partial marker: a lone trailing ESC is held, then released", () => {
    const s = new SyncStreamStripper();
    expect(s.push("x\x1b")).toBe("x");
    expect(s.push("[0m")).toBe("\x1b[0m");
  });

  it("flush returns the held tail on stream end without duplicating it", () => {
    const s = new SyncStreamStripper();
    expect(s.push("y\x1b[?2026")).toBe("y");
    expect(s.flush()).toBe("\x1b[?2026");
    expect(s.flush()).toBe("");
  });

  it("an empty push emits nothing and loses nothing", () => {
    const s = new SyncStreamStripper();
    expect(s.push("")).toBe("");
    expect(s.push("z")).toBe("z");
  });
});
