import { afterEach, describe, expect, it } from "bun:test";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";
import { injectText } from "../session-frames.js";
import {
  insertionFailedMessage,
  insertionTextFor,
  mapWithConcurrency,
  rejectionMessage,
  summarizeUploadBatch,
  type UploadAttempt,
  uploadSessionFile,
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

/**
 * Minimal XHR double: `send()` records the body and answers with a scripted
 * status/body; `upload.onprogress` is hand-driven so progress is assertable.
 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  withCredentials = false;
  status = 0;
  responseText = "";
  sentBody: FormData | null = null;
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.sentBody = body;
    FakeXhr.instances.push(this);
  }
  /** Simulate a settled response. */
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
  failNetwork() {
    this.onerror?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent);
  }
}

const realXhr = globalThis.XMLHttpRequest;
afterEach(() => {
  globalThis.XMLHttpRequest = realXhr;
  FakeXhr.instances = [];
});

describe("uploadSessionFile (XHR transport)", () => {
  it("posts multipart to the session route with cookies and resolves the stored path", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const p = uploadSessionFile("s 1", file);
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/sessions/s%201/uploads");
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.sentBody?.get("file")).toBe(file);
    xhr.respond(
      200,
      JSON.stringify({ path: "/ws/.mote/uploads/a.txt", name: "a.txt", size: 5, contentType: "text/plain" }),
    );
    expect(await p).toBe("/ws/.mote/uploads/a.txt");
  });

  it("reports byte progress through the callback", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const seen: Array<[number, number]> = [];
    const p = uploadSessionFile("s1", new File(["x"], "a.png"), (sent, total) => seen.push([sent, total]));
    const xhr = FakeXhr.instances[0];
    xhr.progress(32768, 262144);
    xhr.progress(262144, 262144);
    xhr.respond(200, JSON.stringify({ path: "/ws/a.png" }));
    await p;
    expect(seen).toEqual([
      [32768, 262144],
      [262144, 262144],
    ]);
  });

  it("prefers the API's structured message on refusal, else the bare status", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const p1 = uploadSessionFile("s1", new File(["x"], "a.txt"));
    FakeXhr.instances[0].respond(409, JSON.stringify({ message: "Session working directory is missing" }));
    await expect(p1).rejects.toThrow("Session working directory is missing");

    const p2 = uploadSessionFile("s1", new File(["x"], "a.txt"));
    FakeXhr.instances[1].respond(500, "boom"); // not JSON
    await expect(p2).rejects.toThrow("Upload failed (500)");
  });

  it("a network failure rejects with a usable message", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const p = uploadSessionFile("s1", new File(["x"], "a.txt"));
    FakeXhr.instances[0].failNetwork();
    await expect(p).rejects.toThrow("network error");
  });
});

describe("mapWithConcurrency", () => {
  it("keeps INPUT order even when completions are out of order", async () => {
    const delays = [30, 0, 15];
    const results = await mapWithConcurrency([0, 1, 2], 3, async (i) => {
      await Bun.sleep(delays[i]);
      return `r${i}`;
    });
    expect(results).toEqual([
      { status: "fulfilled", value: "r0" },
      { status: "fulfilled", value: "r1" },
      { status: "fulfilled", value: "r2" },
    ]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 8 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("isolates rejections: siblings settle normally and the failure is reported in place", async () => {
    const results = await mapWithConcurrency(["a", "b", "c"], 2, async (x) => {
      if (x === "b") throw new Error("nope");
      return x.toUpperCase();
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: "A" });
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: "fulfilled", value: "C" });
  });

  it("maps an empty batch to an empty result", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

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
