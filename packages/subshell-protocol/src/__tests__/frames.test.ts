import { describe, expect, it } from "bun:test";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  DEVICE_LABEL_MAX,
  NODE_NAME_MAX,
  NODE_NAME_MAX_UNITS,
  normalizeDeviceLabel,
  normalizeLabel,
  normalizeNodeName,
  parseClientFrame,
} from "../frames.js";

describe("parseClientFrame", () => {
  it("parses an input frame from a JSON string", () => {
    expect(parseClientFrame(JSON.stringify({ type: "input", data: "hello" }))).toEqual({
      type: "input",
      data: "hello",
    });
  });

  it("parses an input frame from an already-parsed object", () => {
    expect(parseClientFrame({ type: "input", data: "x" })).toEqual({ type: "input", data: "x" });
  });

  it("preserves control bytes in input data", () => {
    const data = "\x04\x1b[A\r";
    expect(parseClientFrame(JSON.stringify({ type: "input", data }))).toEqual({ type: "input", data });
  });

  it("parses a resize frame", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseClientFrame("{not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseClientFrame("[1,2,3]")).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(parseClientFrame(JSON.stringify({ type: "explode" }))).toBeNull();
  });

  it("returns null when input data is not a string", () => {
    expect(parseClientFrame(JSON.stringify({ type: "input", data: 42 }))).toBeNull();
  });

  it("returns null when resize dimensions are missing or non-numeric", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 80 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: "80", rows: 24 }))).toBeNull();
  });

  it("returns null for a resize with non-positive dimensions", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 0, rows: 24 }))).toBeNull();
  });

  it("exposes the bracketed paste markers", () => {
    expect(BRACKETED_PASTE_START).toBe("\x1b[200~");
    expect(BRACKETED_PASTE_END).toBe("\x1b[201~");
  });
});

describe("normalizeLabel", () => {
  it("replaces control characters and collapses whitespace", () => {
    expect(normalizeLabel("prod\r\nplane", 64)).toBe("prod plane");
    expect(normalizeLabel("a  b", 64)).toBe("a b");
  });

  it("strips DEL and C1, which a terminal would swallow", () => {
    expect(normalizeLabel("pro\x7fd\x9bplane", 64)).toBe("pro d plane");
  });

  it("trims and caps at the given max", () => {
    expect(normalizeLabel("  padded  ", 64)).toBe("padded");
    expect(normalizeLabel("x".repeat(80), 64)).toBe("x".repeat(64));
  });

  it("returns empty when nothing usable remains", () => {
    expect(normalizeLabel("\r\n\t", 64)).toBe("");
  });

  it("caps by code point, so a boundary never splits a character in half", () => {
    // `slice(0, max)` counted UTF-16 units. Every other cap on these labels — the
    // agent's --name pre-flight, the desktop form, the plane's chars().count() —
    // counts code points, and an astral label reaching the cap by units would come
    // out ending in a lone surrogate: unrenderable, and unequal to any string a
    // later read of the same row produces.
    const emoji = "\u{1F5A5}"; // 🖥 — two UTF-16 units
    expect(normalizeLabel(emoji.repeat(30), 40)).toBe(emoji.repeat(30));
    expect([...normalizeLabel(emoji.repeat(50), 40)].length).toBe(40);
    // The 40-code-point result is 80 units long and still every character intact.
    expect(normalizeLabel(emoji.repeat(50), 40)).toBe(emoji.repeat(40));
  });

  it("sizes the transport guard to exactly the widest legal name", () => {
    // JSON Schema's `maxLength` and a DOM `maxlength` count UTF-16 units, so the
    // ceiling THEY enforce has to be spoken in units or it refuses a name the rule
    // two lines below accepts: enroll's and rename's bodies said 64 units, which is
    // 32 characters of emoji. A code point is at most two units, so twice the cap is
    // wide enough for every legal name and no wider — anything longer is something
    // `normalizeNodeName` would cap anyway.
    expect(NODE_NAME_MAX_UNITS).toBe(NODE_NAME_MAX * 2);
    const widest = "\u{1F5A5}".repeat(NODE_NAME_MAX); // 64 characters, 128 units
    expect(widest.length).toBe(NODE_NAME_MAX_UNITS);
    expect(normalizeNodeName(widest)).toBe(widest);
    expect([...normalizeNodeName("\u{1F5A5}".repeat(NODE_NAME_MAX + 1))].length).toBe(NODE_NAME_MAX);
  });

  it("leaves normalizeDeviceLabel bound to its own cap", () => {
    expect(normalizeDeviceLabel("y".repeat(80))).toBe("y".repeat(DEVICE_LABEL_MAX));
    expect(normalizeDeviceLabel("dev\r\nice")).toBe("dev ice");
  });
});
