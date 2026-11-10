import { describe, expect, it } from "bun:test";
import { readInstallStream, STALLED_MESSAGE } from "@/hooks/use-install-agent";

/** A body that emits the given chunks, then optionally never ends. */
function bodyOf(frames: string[], { hang = false } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n`));
      if (!hang) controller.close();
    },
  });
}

const DONE = JSON.stringify({
  type: "done",
  ok: true,
  exitCode: 0,
  output: "all good",
  harness: { id: "hermes", installed: true },
});

describe("readInstallStream", () => {
  it("reports each line and resolves on the done frame", async () => {
    const lines: string[] = [];
    const result = await readInstallStream(
      bodyOf([JSON.stringify({ type: "line", text: "→ Existing installation found, updating..." }), DONE]),
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["→ Existing installation found, updating..."]);
    expect(result.ok).toBe(true);
  });

  it("refuses a stream that ended without saying how it went", async () => {
    await expect(readInstallStream(bodyOf([JSON.stringify({ type: "line", text: "…" })]))).rejects.toThrow(
      /without saying whether it worked/,
    );
  });

  // The defect this bound exists for, measured on 2026-09-14: the installer
  // finished and the server closed its side, but the dev proxy between them
  // never passed the close along, so the page span forever.
  it("gives up when the body goes silent and never closes", async () => {
    const started = Date.now();
    await expect(
      readInstallStream(bodyOf([JSON.stringify({ type: "line", text: "working…" })], { hang: true }), undefined, 40),
    ).rejects.toThrow(STALLED_MESSAGE);
    // It waited rather than failing instantly on the first quiet moment.
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("measures silence, not duration: a chatty stream outlives the bound", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 4; i += 1) {
          await new Promise((r) => setTimeout(r, 15));
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "line", text: `step ${i}` })}\n`));
        }
        controller.enqueue(encoder.encode(`${DONE}\n`));
        controller.close();
      },
    });
    // 60ms of total work against a 40ms silence bound that is reset each frame.
    const result = await readInstallStream(body, undefined, 40);
    expect(result.ok).toBe(true);
  });

  it("treats waiting heartbeats as silence-defeating and as nothing to report", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 3; i += 1) {
          await new Promise((r) => setTimeout(r, 15));
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "waiting" })}\n`));
        }
        controller.enqueue(encoder.encode(`${DONE}\n`));
        controller.close();
      },
    });
    const lines: string[] = [];
    // 45ms of total work against a 40ms silence bound: without heartbeats
    // this would have been reported as a stalled update.
    const result = await readInstallStream(body, (line) => lines.push(line), 40);
    expect(result.ok).toBe(true);
    expect(lines).toEqual([]);
  });

  it("lets a caller name its own failure copy", async () => {
    await expect(
      readInstallStream(bodyOf([JSON.stringify({ type: "line", text: "…" })]), undefined, undefined, {
        ended: "The update ended without saying whether it worked.",
      }),
    ).rejects.toThrow(/update ended without saying/);
  });

  it("refuses a done payload its validator rejects", async () => {
    await expect(
      readInstallStream(
        bodyOf([JSON.stringify({ type: "done", junk: true })]),
        undefined,
        undefined,
        { malformed: "unreadable result" },
        () => null,
      ),
    ).rejects.toThrow("unreadable result");
  });
});
