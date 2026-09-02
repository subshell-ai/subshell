import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NodeCommandBody,
  type NodeEvent,
  type NodeLogReadResult,
  parseNodeLogReadResult,
  parseNodePromptDeliver,
} from "@internal/session-protocol";
import type { CommandContext, CommandWs } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execPromptDeliver } from "../commands/prompt.js";
import { stopAllTails, TAIL_BACKPRESSURE_BYTES, TAIL_BACKSTOP_MS, TAIL_CHUNK_BYTES } from "../commands/tail.js";
import type { AgentConfig } from "../config.js";
import { SessionMetaStore } from "../session-meta.js";

/**
 * Task 5: `prompt_deliver` + `log_read` + `tail_start`/`tail_stop` (spec
 * 2026-08-31 §3.4/§6.5). Same fake-tmux discipline as commands-basics/launch:
 * a plain-object double records ordered calls, unstubbed methods throw. The
 * tail tests use REAL temp files (the pump reads through `Bun.file` +
 * `fs.watch`, which is exactly the code under test) under a temp home — never
 * `~/.config`. Results are asserted against the REAL Task-1 validators from
 * `@internal/session-protocol` (`parseNodePromptDeliver`,
 * `parseNodeLogReadResult`) — an agent answer the backend would reject is a bug.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const FIXED_NOW = 1_700_000_000_000;

let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-prompt-tail-")));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A fresh temp dataDir per test. */
function freshDataDir(tag: string): string {
  const dir = join(base, tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

type TmuxSpec = {
  capturePane?: (socket: string, id: string) => string;
  sendInput?: (socket: string, id: string, data: string) => void;
  pressEnter?: (socket: string, id: string) => void;
};

interface FakeTmux {
  tmux: CommandContext["tmux"];
  calls: Array<{ method: string; args: unknown[] }>;
  count: (method: keyof TmuxSpec) => number;
  argsOf: (method: keyof TmuxSpec) => unknown[][];
}

function fakeTmux(spec: TmuxSpec): FakeTmux {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const m =
    (name: keyof TmuxSpec) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      const impl = spec[name];
      if (!impl) throw new Error(`fake tmux: unstubbed call ${String(name)}(${JSON.stringify(args)})`);
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  return {
    tmux: {
      capturePane: m("capturePane"),
      sendInput: m("sendInput"),
      pressEnter: m("pressEnter"),
    } as unknown as CommandContext["tmux"],
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    argsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
  };
}

/** Scripted captures: consume the list, then repeat the last entry forever. */
function scriptedCaptures(script: Array<string | Error>): { capture: () => string; reads: () => number } {
  let i = 0;
  return {
    capture: () => {
      const v = script[Math.min(i, script.length - 1)];
      i += 1;
      if (v instanceof Error) throw v;
      return v;
    },
    reads: () => i,
  };
}

/** A fake ws with a SETTABLE bufferedAmount (the pump's backpressure seam) and an optional throwing send. */
interface FakeWs {
  ws: CommandWs;
  events: NodeEvent[];
  bufferedAmount: number | undefined;
  throwOnSend: boolean;
}

function fakeWs(): FakeWs {
  const f: FakeWs = {
    ws: undefined as unknown as CommandWs,
    events: [],
    bufferedAmount: undefined,
    throwOnSend: false,
  };
  f.ws = {
    send: (ev: NodeEvent) => {
      if (f.throwOnSend) throw new Error("ws send exploded");
      f.events.push(ev);
    },
    get bufferedAmount() {
      return f.bufferedAmount;
    },
  };
  return f;
}

const live: CommandContext[] = [];

function makeCtx(
  dataDir: string,
  tmux: CommandContext["tmux"],
  opts: { nowMs?: () => number; ws?: FakeWs } = {},
): { ctx: CommandContext; ws: FakeWs } {
  const ws = opts.ws ?? fakeWs();
  const config: AgentConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const ctx: CommandContext = {
    config,
    tmux,
    meta: new SessionMetaStore(dataDir),
    nowMs: opts.nowMs ?? ((): number => FIXED_NOW),
    ws: ws.ws,
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
  };
  live.push(ctx);
  return { ctx, ws };
}

// No test may leave a pump's watcher/timer behind (the daemon-close sweep is
// the production path; here it is the teardown).
afterEach(() => {
  for (const ctx of live.splice(0)) stopAllTails(ctx);
});

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function outputs(events: NodeEvent[]): Extract<NodeEvent, { type: "output" }>[] {
  return events.filter((e): e is Extract<NodeEvent, { type: "output" }> => e.type === "output");
}

/** Create the sessions dir + the pane log the pump will watch. */
function seedLog(ctx: CommandContext, sessionId: string, content: string | Buffer): string {
  const dir = join(ctx.config.dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = ctx.meta.logPath(sessionId);
  writeFileSync(file, content);
  return file;
}

function tailStartCmd(over: Partial<Extract<NodeCommandBody, { type: "tail_start" }>> = {}) {
  return { type: "tail_start", sessionId: S1, subId: "sub-1", fromByte: 0, ...over } as const;
}

/* ------------------------------------------------------------------ */
/* prompt_deliver (port of LocalLauncher.deliverPrompt)                 */
/* ------------------------------------------------------------------ */

describe("execPromptDeliver (spec §6.5)", () => {
  async function recordSocket(ctx: CommandContext): Promise<void> {
    await ctx.meta.record({
      sessionId: S1,
      cwd: ctx.config.dataDir,
      socket: "p-sock",
      harnessId: "claude-code",
      name: "m",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
  }

  it('settles after two blank captures ("", "", "ready") ⇒ input + enter run, {promptDelivered:true}', async () => {
    const script = scriptedCaptures(["", "", "ready"]);
    const ft = fakeTmux({ capturePane: () => script.capture(), sendInput: () => {}, pressEnter: () => {} });
    const { ctx: c } = makeCtx(freshDataDir("prompt-settle"), ft.tmux);
    await recordSocket(c);
    const result = await dispatchCommand(c, {
      type: "prompt_deliver",
      sessionId: S1,
      text: "hi",
      settleTimeoutMs: 200,
      pollMs: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The result shape is the Task-1 contract, validated by the REAL parser.
    expect(parseNodePromptDeliver(result.data)).toEqual({ promptDelivered: true });
    expect(script.reads()).toBe(3); // "" → sleep → "" → sleep → "ready" (ctx.nowMs stays FIXED; the settle break bounds the loop)
    expect(ft.count("capturePane")).toBe(3);
    expect(ft.argsOf("sendInput")).toEqual([["p-sock", S1, "hi"]]); // recorded socket, byte-for-byte text
    expect(ft.argsOf("pressEnter")).toEqual([["p-sock", S1]]);
  });

  it("never settles (ANSI-escape-only screen) ⇒ {promptDelivered:false}, NO input, NO enter", async () => {
    // An advancing injected clock proves the deadline math runs on ctx.nowMs(),
    // not a private Date.now(). +10 ms per read, 60 ms window ⇒ ~5 captures.
    let t = 0;
    const ft = fakeTmux({ capturePane: () => "\x1b[2J\x1b[H" }); // stripAnsi ⇒ "" (still booting)
    const { ctx } = makeCtx(freshDataDir("prompt-timeout"), ft.tmux, {
      nowMs: () => (t += 10),
    });
    const result = await dispatchCommand(ctx, {
      type: "prompt_deliver",
      sessionId: S1,
      text: "hi",
      settleTimeoutMs: 60,
      pollMs: 20,
    });
    expect(result.ok && result.data).toEqual({ promptDelivered: false });
    expect(parseNodePromptDeliver(result.ok ? result.data : null)).toEqual({ promptDelivered: false });
    expect(ft.count("capturePane")).toBeGreaterThanOrEqual(2);
    expect(ft.count("sendInput")).toBe(0);
    expect(ft.count("pressEnter")).toBe(0);
  });

  it("capturePane throws early (pane not queryable yet) ⇒ keeps polling, still settles", async () => {
    const script = scriptedCaptures([new Error("can't find pane"), new Error("can't find pane"), "ready"]);
    const ft = fakeTmux({
      capturePane: () => script.capture(),
      sendInput: () => {},
      pressEnter: () => {},
    });
    const { ctx } = makeCtx(freshDataDir("prompt-capture-throws"), ft.tmux);
    const result = await execPromptDeliver(ctx, {
      type: "prompt_deliver",
      sessionId: S1,
      text: "go",
      settleTimeoutMs: 2_000,
      pollMs: 20,
    });
    expect(result).toEqual({ ok: true, data: { promptDelivered: true } });
    expect(ft.count("sendInput")).toBe(1); // orphan id: tmuxSocketFor fallback, no meta record needed
    expect(ft.argsOf("sendInput")[0]?.[2]).toBe("go");
  });

  it("sendInput throws ⇒ swallowed ⇒ {promptDelivered:false}, pressEnter never runs", async () => {
    const ft = fakeTmux({
      capturePane: () => "ready",
      sendInput: () => {
        throw new Error("no pane");
      },
      pressEnter: () => {},
    });
    const { ctx } = makeCtx(freshDataDir("prompt-input-throws"), ft.tmux);
    const result = await dispatchCommand(ctx, {
      type: "prompt_deliver",
      sessionId: S1,
      text: "hi",
      settleTimeoutMs: 200,
      pollMs: 20,
    });
    expect(result.ok && result.data).toEqual({ promptDelivered: false });
    expect(ft.count("pressEnter")).toBe(0);
  });

  it("malformed session id ⇒ ok:false 'invalid session id', NO tmux touch", async () => {
    const ft = fakeTmux({ capturePane: () => "ready" });
    const { ctx } = makeCtx(freshDataDir("prompt-bad-id"), ft.tmux);
    const result = await dispatchCommand(ctx, {
      type: "prompt_deliver",
      sessionId: "../evil",
      text: "hi",
      settleTimeoutMs: 50,
      pollMs: 10,
    });
    expect(result).toEqual({ ok: false, error: "invalid session id" });
    expect(ft.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* log_read                                                            */
/* ------------------------------------------------------------------ */

describe("execLogRead (spec §3.4)", () => {
  function readCmd(fromByte: number, maxBytes: number) {
    return { type: "log_read", sessionId: S1, fromByte, maxBytes } as const;
  }

  it("missing file ⇒ {bytes_b64:'', next, size:0} — a valid EMPTY read, not an error", async () => {
    const { ctx } = makeCtx(freshDataDir("logread-missing"), (() => {}) as never);
    const result = await dispatchCommand(ctx, readCmd(0, 64));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ bytes_b64: "", next: 0, size: 0 });
    expect(parseNodeLogReadResult(result.data)).not.toBeNull();
  });

  it("fromByte past a shrunken/vanished EOF ⇒ clamped to size so the EMPTY-read validator invariant holds", async () => {
    const { ctx } = makeCtx(freshDataDir("logread-missing-offset"), (() => {}) as never);
    const result = await dispatchCommand(ctx, readCmd(10, 64));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // next MUST NOT exceed size on an empty read — parseNodeLogReadResult rejects that.
    expect(parseNodeLogReadResult(result.data)).toEqual({ bytes_b64: "", next: 0, size: 0 });
  });

  it("fromByte == EOF ⇒ empty with the REAL size; mid-file ⇒ the exact slice + next", async () => {
    const { ctx } = makeCtx(freshDataDir("logread-slice"), (() => {}) as never);
    seedLog(ctx, S1, "abcdef");
    const atEof = await dispatchCommand(ctx, readCmd(6, 64));
    expect(atEof.ok && parseNodeLogReadResult(atEof.ok ? atEof.data : null)).toEqual({
      bytes_b64: "",
      next: 6,
      size: 6,
    });

    const mid = await dispatchCommand(ctx, readCmd(2, 2));
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    const parsed = parseNodeLogReadResult(mid.data) as NodeLogReadResult;
    expect(parsed).toEqual({ bytes_b64: Buffer.from("cd").toString("base64"), next: 4, size: 6 });
    expect(Buffer.from(parsed.bytes_b64, "base64").toString("utf8")).toBe("cd");

    const capped = await dispatchCommand(ctx, readCmd(2, 100)); // maxBytes past EOF clamps to size
    expect(capped.ok && capped.data).toEqual({
      bytes_b64: Buffer.from("cdef").toString("base64"),
      next: 6,
      size: 6,
    });
  });

  it("malformed session id ⇒ ok:false 'invalid session id'", async () => {
    const { ctx } = makeCtx(freshDataDir("logread-bad-id"), (() => {}) as never);
    const result = await dispatchCommand(ctx, { type: "log_read", sessionId: "a/b", fromByte: 0, maxBytes: 8 });
    expect(result).toEqual({ ok: false, error: "invalid session id" });
  });
});

/* ------------------------------------------------------------------ */
/* tail_start / tail_stop (port of LocalLauncher.tailStart)             */
/* ------------------------------------------------------------------ */

describe("tail executors (spec §3.1/§3.4)", () => {
  it("constants pin the frozen contract", () => {
    expect(TAIL_CHUNK_BYTES).toBe(192 * 1024); // ≤ 192 KiB RAW per output event
    expect(TAIL_BACKPRESSURE_BYTES).toBe(512 * 1024);
    expect(TAIL_BACKSTOP_MS).toBe(1_000);
  });

  it("catch-up: bytes written BEFORE tail_start arrive as ONE output event", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-catchup"), (() => {}) as never);
    seedLog(ctx, S1, "abc");
    const result = await dispatchCommand(ctx, tailStartCmd());
    expect(result).toEqual({ ok: true });
    expect(ctx.tails.has("sub-1")).toBe(true);
    await waitFor(() => outputs(ws.events).length >= 1, "catch-up output");
    expect(outputs(ws.events)[0]).toEqual({
      type: "output",
      sessionId: S1,
      subId: "sub-1",
      fromByte: 0,
      toByte: 3,
      data_b64: Buffer.from("abc").toString("base64"),
    });
  });

  it("append after tail_start ⇒ a second event {fromByte:3,toByte:5}; tail_stop then append ⇒ nothing", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-append"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    expect(await dispatchCommand(ctx, tailStartCmd())).toEqual({ ok: true });
    await waitFor(() => outputs(ws.events).length >= 1, "catch-up output");

    appendFileSync(file, "de");
    await waitFor(() => outputs(ws.events).length >= 2, "append output"); // watch fires; the 1 s backstop is the safety net
    expect(outputs(ws.events)[1]).toMatchObject({ subId: "sub-1", fromByte: 3, toByte: 5 });
    expect(Buffer.from(outputs(ws.events)[1].data_b64, "base64").toString("utf8")).toBe("de");

    expect(await dispatchCommand(ctx, { type: "tail_stop", subId: "sub-1" })).toEqual({ ok: true });
    expect(ctx.tails.size).toBe(0);
    appendFileSync(file, "f");
    await sleep(TAIL_BACKSTOP_MS + 300); // outlast the backstop window: a live pump WOULD have delivered
    expect(outputs(ws.events).length).toBe(2);
  });

  it("tail_stop on an unknown subId is still {ok:true} (idempotent)", async () => {
    const { ctx } = makeCtx(freshDataDir("tail-stop-unknown"), (() => {}) as never);
    expect(await dispatchCommand(ctx, { type: "tail_stop", subId: "never-started" })).toEqual({ ok: true });
  });

  it("chunking: 300 KiB in one go ⇒ ≥2 events, each ≤ 192 KiB RAW, contiguous offsets", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-chunking"), (() => {}) as never);
    const blob = Buffer.alloc(300 * 1024, 0x41);
    seedLog(ctx, S1, blob);
    expect(await dispatchCommand(ctx, tailStartCmd())).toEqual({ ok: true });
    await waitFor(() => outputs(ws.events).length >= 2, "two chunks");
    const evs = outputs(ws.events);
    let cursor = 0;
    let total = 0;
    for (const ev of evs) {
      const raw = Buffer.from(ev.data_b64, "base64");
      expect(raw.byteLength).toBeLessThanOrEqual(TAIL_CHUNK_BYTES); // the cap is on the RAW slice
      expect(ev.fromByte).toBe(cursor);
      expect(ev.toByte).toBe(cursor + raw.byteLength);
      expect(ev.sessionId).toBe(S1);
      cursor = ev.toByte;
      total += raw.byteLength;
    }
    expect(total).toBe(300 * 1024);
    expect(cursor).toBe(300 * 1024);
    expect(Buffer.concat(evs.map((e) => Buffer.from(e.data_b64, "base64"))).equals(blob)).toBe(true);
  });

  it("backpressure: a stuffed socket delays delivery; the RESULT still resolves; bytes arrive when it drains", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-backpressure"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    ws.bufferedAmount = TAIL_BACKPRESSURE_BYTES + 1; // stuffed BEFORE the catch-up pump sends
    const t0 = Date.now();
    expect(await dispatchCommand(ctx, tailStartCmd())).toEqual({ ok: true }); // result NOT blocked by the pump
    expect(Date.now() - t0).toBeLessThan(900);
    await sleep(80);
    expect(outputs(ws.events).length).toBe(0); // the pump is parked in its backpressure loop
    ws.bufferedAmount = 0; // socket drains
    await waitFor(() => outputs(ws.events).length >= 1, "first output after drain");

    ws.bufferedAmount = TAIL_BACKPRESSURE_BYTES + 1;
    appendFileSync(file, "de");
    await sleep(80);
    expect(outputs(ws.events).length).toBe(1); // second event delayed, not lost
    ws.bufferedAmount = 0;
    await waitFor(() => outputs(ws.events).length >= 2, "second output after drain");
    expect(outputs(ws.events)[1]).toMatchObject({ fromByte: 3, toByte: 5 });
  });

  it("a vanished file stops that sub cleanly (handle gone, later writes are never streamed)", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-vanish"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    expect(await dispatchCommand(ctx, tailStartCmd())).toEqual({ ok: true });
    await waitFor(() => outputs(ws.events).length >= 1, "catch-up output");
    rmSync(file);
    await waitFor(() => ctx.tails.size === 0, "tail self-stop after the log vanished");
    // Recreate with fresh bytes: the STOPPED pump must never resurrect or stream them.
    writeFileSync(file, "xyz");
    await sleep(200);
    expect(outputs(ws.events).length).toBe(1);
    expect(ctx.tails.size).toBe(0);
  });

  it("send throwing twice in a row self-stops the sub (a dead ws must not be pumped into)", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-send-throws"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    ws.throwOnSend = true;
    expect(await dispatchCommand(ctx, tailStartCmd())).toEqual({ ok: true });
    await sleep(60); // first failure: transient, the sub survives
    expect(ctx.tails.size).toBe(1);
    appendFileSync(file, "de"); // second failure (consecutive) ⇒ stop
    await waitFor(() => ctx.tails.size === 0, "self-stop after two consecutive send failures");
    expect(ws.events.length).toBe(0); // nothing ever landed
  });

  it("duplicate subId ⇒ replace-with-stop: one live handle, the old pump streams nothing", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-dup"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    expect(await dispatchCommand(ctx, tailStartCmd({ fromByte: 0 }))).toEqual({ ok: true });
    await waitFor(() => outputs(ws.events).length >= 1, "first pump catch-up");
    const first = ctx.tails.get("sub-1");
    expect(first).toBeDefined();
    expect(await dispatchCommand(ctx, tailStartCmd({ fromByte: 3 }))).toEqual({ ok: true });
    expect(ctx.tails.size).toBe(1);
    expect(ctx.tails.get("sub-1")).not.toBe(first);
    const baseline = outputs(ws.events).length;
    appendFileSync(file, "de");
    await waitFor(() => outputs(ws.events).length >= baseline + 1, "replacement pump append");
    const lastEv = outputs(ws.events)[outputs(ws.events).length - 1];
    expect(lastEv).toMatchObject({ subId: "sub-1", fromByte: 3, toByte: 5 });
    await sleep(150);
    // The replaced pump is DEAD: exactly ONE event for the append, never a duplicate pair.
    expect(outputs(ws.events).length).toBe(baseline + 1);
    first?.stop(); // idempotent even after the forced replace
  });

  it("stopAllTails drains ctx.tails (the daemon close path)", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-stop-all"), (() => {}) as never);
    const file = seedLog(ctx, S1, "abc");
    expect(await dispatchCommand(ctx, tailStartCmd({ subId: "a" }))).toEqual({ ok: true });
    expect(await dispatchCommand(ctx, { type: "tail_start", sessionId: S1, subId: "b", fromByte: 0 })).toEqual({
      ok: true,
    });
    expect(ctx.tails.size).toBe(2);
    // The catch-up reads run in the pumps (the result never blocks on them) —
    // let both land BEFORE pulling the plug.
    await waitFor(() => outputs(ws.events).length >= 2, "both catch-up outputs");
    stopAllTails(ctx);
    expect(ctx.tails.size).toBe(0);
    appendFileSync(file, "de");
    await sleep(200);
    // Only the two catch-up events (sub a and b each read [0,3)); the append streams to nobody.
    expect(outputs(ws.events).length).toBe(2);
  });

  it("tail_start with a malformed session id ⇒ ok:false, no handle, no fs touch", async () => {
    const { ctx, ws } = makeCtx(freshDataDir("tail-bad-id"), (() => {}) as never);
    const result = await dispatchCommand(ctx, {
      type: "tail_start",
      sessionId: "..%2fevil",
      subId: "sub-x",
      fromByte: 0,
    });
    expect(result).toEqual({ ok: false, error: "invalid session id" });
    expect(ctx.tails.size).toBe(0);
    expect(ws.events).toEqual([]);
  });
});
