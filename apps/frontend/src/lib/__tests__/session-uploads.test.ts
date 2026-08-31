import { describe, expect, it } from "bun:test";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";
import { injectText } from "../session-frames.js";
import {
  insertionFailedMessage,
  insertionTextFor,
  rejectionMessage,
  summarizeUploadBatch,
  type UploadAttempt,
} from "../session-uploads.js";

describe("insertionTextFor", () => {
  it("returns a single path with a trailing space when not multiline", () => {
    expect(insertionTextFor(["/ws/.mote/uploads/a.png"], false)).toBe("/ws/.mote/uploads/a.png ");
  });

  it("returns a single path with a trailing space when multiline", () => {
    expect(insertionTextFor(["/ws/.mote/uploads/a.png"], true)).toBe("/ws/.mote/uploads/a.png ");
  });

  it("space-joins several paths when not multiline (no bracketed paste)", () => {
    expect(insertionTextFor(["/ws/a.png", "/ws/b.pdf"], false)).toBe("/ws/a.png /ws/b.pdf ");
  });

  it("newline-joins several paths when multiline (bracketed paste active)", () => {
    expect(insertionTextFor(["/ws/a.png", "/ws/b.pdf"], true)).toBe("/ws/a.png\n/ws/b.pdf ");
  });

  it("returns an empty string for no paths, regardless of multiline", () => {
    expect(insertionTextFor([], false)).toBe("");
    expect(insertionTextFor([], true)).toBe("");
  });
});

describe("rejectionMessage", () => {
  it("names the file and reason", () => {
    const msg = rejectionMessage([{ file: { name: "huge.bin" }, errors: [{ message: "File is larger than 25 MB" }] }]);
    expect(msg).toContain("huge.bin");
    expect(msg).toContain("larger than 25 MB");
  });

  it("summarizes several rejections on one line", () => {
    const msg = rejectionMessage([
      { file: { name: "a.bin" }, errors: [{ message: "too big" }] },
      { file: { name: "b.bin" }, errors: [{ message: "too big" }] },
    ]);
    expect(msg).toContain("a.bin");
    expect(msg).toContain("b.bin");
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("returns an empty string when nothing was rejected", () => {
    expect(rejectionMessage([])).toBe("");
  });
});

/** Builds a fulfilled attempt for the given file name and stored path. */
function ok(name: string, path: string): UploadAttempt {
  return { name, result: { status: "fulfilled", value: path } };
}

/** Builds a rejected attempt for the given file name and failure reason. */
function fail(name: string, reason: string): UploadAttempt {
  return { name, result: { status: "rejected", reason: new Error(reason) } };
}

describe("summarizeUploadBatch", () => {
  it("keeps the successful paths and names the failed file on partial failure", () => {
    const { paths, error } = summarizeUploadBatch([ok("a.png", "/ws/a.png"), fail("huge.bin", "too big")], "");
    expect(paths).toEqual(["/ws/a.png"]);
    expect(error).toContain("huge.bin");
    expect(error).toContain("too big");
  });

  it("reports a dropzone rejection alongside successful uploads (mixed drop)", () => {
    const { paths, error } = summarizeUploadBatch([ok("a.png", "/ws/a.png")], "huge.bin: File is larger than 25 MB");
    expect(paths).toEqual(["/ws/a.png"]);
    expect(error).toContain("huge.bin");
    expect(error).toContain("larger than 25 MB");
  });

  it("yields no paths and a message when every upload fails", () => {
    const { paths, error } = summarizeUploadBatch([fail("a.bin", "network error"), fail("b.bin", "network error")], "");
    expect(paths).toEqual([]);
    expect(error).toContain("a.bin");
    expect(error).toContain("b.bin");
  });

  it("returns no error when every upload succeeds and nothing was rejected", () => {
    const { paths, error } = summarizeUploadBatch([ok("a.png", "/ws/a.png")], "");
    expect(paths).toEqual(["/ws/a.png"]);
    expect(error).toBeNull();
  });
});

describe("insertionFailedMessage", () => {
  it("names the stored paths", () => {
    const msg = insertionFailedMessage(["/ws/a.png", "/ws/b.pdf"]);
    expect(msg).toContain("/ws/a.png");
    expect(msg).toContain("/ws/b.pdf");
  });
});

/** Minimal open-socket stub that records what was sent. */
function fakeWs() {
  const sent: string[] = [];
  return { ws: { readyState: 1, send: (d: string) => sent.push(d) } as unknown as WebSocket, sent };
}

describe("injectText", () => {
  it("wraps text in paste markers when the remote enabled bracketed paste", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "/ws/a.png ", true);
    expect(JSON.parse(sent[0])).toEqual({
      type: "input",
      data: `${BRACKETED_PASTE_START}/ws/a.png ${BRACKETED_PASTE_END}`,
    });
  });

  it("sends bare text when bracketed paste is off", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "/ws/a.png ", false);
    expect(JSON.parse(sent[0])).toEqual({ type: "input", data: "/ws/a.png " });
  });

  it("sends nothing for empty text", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "", true);
    expect(sent).toEqual([]);
  });
});
