import { describe, expect, it } from "bun:test";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  DEVICE_LABEL_MAX,
  normalizeDeviceLabel,
  normalizeLabel,
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

  it("leaves normalizeDeviceLabel bound to its own cap", () => {
    expect(normalizeDeviceLabel("y".repeat(80))).toBe("y".repeat(DEVICE_LABEL_MAX));
    expect(normalizeDeviceLabel("dev\r\nice")).toBe("dev ice");
  });
});
