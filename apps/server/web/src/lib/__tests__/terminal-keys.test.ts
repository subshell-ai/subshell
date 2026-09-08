import { describe, expect, it } from "bun:test";
import { isPasteChord } from "@/lib/terminal-keys";

/**
 * The paste chord decides whether the terminal ENCODES a keystroke for the
 * pane or lets the browser's paste pipeline own it. Getting it wrong is
 * user-visible in both directions: too narrow and the harness CLI answers
 * Ctrl+V by reading the SERVER's clipboard ("No image found in clipboard",
 * 2026-09-02); too wide and ordinary keystrokes stop reaching the pane.
 */

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init);

describe("isPasteChord", () => {
  it("matches Ctrl+V and Cmd+V, in either letter case", () => {
    expect(isPasteChord(key({ key: "v", ctrlKey: true }))).toBe(true);
    expect(isPasteChord(key({ key: "v", metaKey: true }))).toBe(true);
    // Caps lock / Shift report an uppercase `key`.
    expect(isPasteChord(key({ key: "V", ctrlKey: true }))).toBe(true);
  });

  it("matches Ctrl+Shift+V — Chrome's paste-as-plain-text also fires a paste event", () => {
    expect(isPasteChord(key({ key: "V", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("ignores Alt combinations so they still reach the pane as input", () => {
    expect(isPasteChord(key({ key: "v", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPasteChord(key({ key: "v", altKey: true }))).toBe(false);
  });

  it("ignores a bare v and other modified letters", () => {
    expect(isPasteChord(key({ key: "v" }))).toBe(false);
    expect(isPasteChord(key({ key: "c", ctrlKey: true }))).toBe(false);
    expect(isPasteChord(key({ key: "b", metaKey: true }))).toBe(false);
  });
});
