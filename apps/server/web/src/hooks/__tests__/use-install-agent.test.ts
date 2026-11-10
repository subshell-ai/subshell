import { afterEach, describe, expect, it } from "bun:test";
import { NODE_QUERY_KEY } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { readInstallStream, STALLED_MESSAGE, useInstallAgent } from "@/hooks/use-install-agent";

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

/** A test-owned QueryClient so invalidation can be observed directly. */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidated: unknown[] = [];
  const originalInvalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((opts: unknown) => {
    invalidated.push(opts);
    return originalInvalidate(opts as Parameters<typeof originalInvalidate>[0]);
  }) as typeof client.invalidateQueries;
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper, invalidated };
}

function mockFetch(body: string) {
  const calls: { method: string; url: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", url: url.pathname });
    return Promise.resolve(new Response(body, { headers: { "content-type": "application/x-ndjson" } }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const nodeDone = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: "done", harnessId: "claude", ok: true, exitCode: 0, output: "", durationMs: 3, timedOut: false, ...over })}\n`;

afterEach(cleanup);

/**
 * The two routes this hook speaks. Both answer the same NDJSON protocol, so
 * the argument order is the whole contract: existing callers pass `onLine`
 * alone and keep the setup route; the harness card passes a node id and gets
 * the enrolled node's route, whose `done` frame carries the run's result and
 * no harness row.
 */
describe("useInstallAgent", () => {
  it("POSTs the node route when a node id is given, and reads the remote result", async () => {
    const { wrapper, invalidated } = makeWrapper();
    const { calls, restore } = mockFetch(nodeDone({ ok: false, exitCode: 7, output: "boom", timedOut: true }));
    try {
      const { result } = renderHook(() => useInstallAgent(undefined, "node1"), { wrapper });
      const answer = await result.current.mutateAsync("claude");
      expect(calls).toContainEqual({ method: "POST", url: "/api/nodes/node1/harnesses/claude/install" });
      expect(answer).toEqual({ ok: false, exitCode: 7, output: "boom", timedOut: true });
      // The node view is what carries the new row, so settling refreshes it.
      const keys = invalidated.map((opts) =>
        opts !== null && typeof opts === "object" && "queryKey" in opts ? opts.queryKey : undefined,
      );
      expect(keys).toContainEqual([...NODE_QUERY_KEY, "node1"]);
    } finally {
      restore();
    }
  });

  it("keeps the setup route for callers that pass no node id", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch(
      `${JSON.stringify({ type: "done", ok: true, exitCode: 0, output: "", harness: { id: "claude", installed: true } })}\n`,
    );
    try {
      const { result } = renderHook(() => useInstallAgent(), { wrapper });
      await result.current.mutateAsync("claude");
      expect(calls).toContainEqual({ method: "POST", url: "/api/setup/agents/claude/install" });
    } finally {
      restore();
    }
  });
});
