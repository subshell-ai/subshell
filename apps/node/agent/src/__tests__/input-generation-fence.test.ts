import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_RESULT_SSH_GENERATION_STALE,
  type NodeCommandBody,
  type NodeEvent,
  parseNodeCommandBody,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { getInputGenerationStore, resetInputGenerationStoresForTests } from "../input-generation.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * The SSH input-generation fence (SSH-SUPPORT.md §3, task-C brief deliverable
 * 2): the store's monotonic mirror, and the EXACT refusal every writer gets.
 * Two invariants the tests pin:
 *
 * - The wire spelling is the frozen constant BY EQUALITY - the plane matches
 *   `NodeRpcError.detail` against `NODE_RESULT_SSH_GENERATION_STALE`; a
 *   reworded refusal silently un-maps every takeover fence into a generic
 *   "failed". The literal is asserted too, so a change to either side fails.
 * - A refused write touches nothing: no tmux call, no settle wait. And an
 *   ordinary pane (no record) behaves byte-identically to before the feature.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

let base: string;
let dataDir: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-ingenfence-")));
  dataDir = join(base, "data");
  mkdirSync(dataDir, { recursive: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => {
  // Every test starts from an empty mirror AND an empty file: the store is
  // process-wide per dataDir, and persistence is the feature - so isolation
  // means dropping both halves between tests.
  resetInputGenerationStoresForTests();
  try {
    rmSync(join(dataDir, "ssh-input-generations.json"), { force: true });
  } catch {
    /* not written yet */
  }
});

interface FakeCtx {
  ctx: CommandContext;
  calls: Array<{ method: string; args: unknown[] }>;
}

function makeCtx(spec: {
  sendInput?: (...args: unknown[]) => unknown;
  capturePane?: () => string;
  pressEnter?: () => void;
}): FakeCtx {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const method =
    (name: string, impl?: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      if (!impl) throw new Error(`fake tmux: unstubbed call ${name}`);
      return impl(...args);
    };
  const raw = {
    sendInput: method("sendInput", spec.sendInput),
    capturePane: method("capturePane", spec.capturePane),
    pressEnter: method("pressEnter", spec.pressEnter),
  };
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const ctx: CommandContext = {
    config,
    tmux: raw as unknown as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: (_ev: NodeEvent) => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
  return { ctx, calls };
}

/** Feed one raw command through the REAL wire parser, then dispatch it. */
async function dispatchRaw(ctx: CommandContext, body: Record<string, unknown>) {
  const cmd: NodeCommandBody | null = parseNodeCommandBody(body);
  if (!cmd) throw new Error(`fixture is not a valid command: ${JSON.stringify(body)}`);
  return await dispatchCommand(ctx, cmd);
}

describe("InputGenerationStore", () => {
  it("no record = ordinary pane: check passes even a missing or stale-looking generation", () => {
    const store = getInputGenerationStore(dataDir);
    expect(store.current(S1)).toBeNull();
    expect(store.check(S1, undefined)).toBe("ok");
    expect(store.check(S1, 0)).toBe("ok");
  });

  it("record establishes the pane as managed; below refuses, equal-or-above passes", () => {
    const store = getInputGenerationStore(dataDir);
    store.record(S1, 3);
    expect(store.current(S1)).toBe(3);
    expect(store.check(S1, undefined)).toBe("stale");
    expect(store.check(S1, 2)).toBe("stale");
    expect(store.check(S1, 3)).toBe("ok");
    expect(store.check(S1, 4)).toBe("ok");
  });

  it("record is monotonic: a replayed lower transition cannot un-fence, and answers the still-current value", () => {
    const store = getInputGenerationStore(dataDir);
    store.record(S1, 5);
    expect(store.record(S1, 4)).toBe(5);
    expect(store.current(S1)).toBe(5);
    expect(store.record(S1, 5)).toBe(5);
    expect(store.record(S1, 6)).toBe(6);
  });

  it("forgets a pane: the fence lifts and the persisted file follows", () => {
    const store = getInputGenerationStore(dataDir);
    store.record(S1, 2);
    store.forget(S1);
    expect(store.current(S1)).toBeNull();
    const persisted = JSON.parse(readFileSync(join(dataDir, "ssh-input-generations.json"), "utf8"));
    expect(persisted.generations[S1]).toBeUndefined();
  });

  it("refuses a bad id on record (the store-throwing-id rule) and never looks it up as managed", () => {
    const store = getInputGenerationStore(dataDir);
    expect(() => store.record("../../etc/passwd", 1)).toThrow("invalid subshell id");
    expect(store.current("../../etc/passwd")).toBeNull();
    store.forget("not an id"); // total on the cleanup path
  });

  it("survives an agent restart: a fresh store re-reads the file and a stale write is STILL refused", () => {
    getInputGenerationStore(dataDir).record(S1, 7);
    resetInputGenerationStoresForTests();
    const reopened = getInputGenerationStore(dataDir);
    expect(reopened.current(S1)).toBe(7);
    expect(reopened.check(S1, 6)).toBe("stale");
  });

  it("a corrupt file reads as no managed panes (never a crash, never a bogus fence)", () => {
    writeFileSync(join(dataDir, "ssh-input-generations.json"), "{ not json");
    const store = getInputGenerationStore(dataDir);
    expect(store.current(S1)).toBeNull();
    expect(store.check(S1, 1)).toBe("ok");
  });
});

describe("input command generation fence", () => {
  it("refuses a managed pane's write below the mirror, touching nothing", async () => {
    getInputGenerationStore(dataDir).record(S1, 4);
    const { ctx, calls } = makeCtx({ sendInput: () => {} });
    const result = await dispatchRaw(ctx, { type: "input", subshellId: S1, data: "ls\r", inputGeneration: 3 });
    expect(result).toEqual({ ok: false, error: NODE_RESULT_SSH_GENERATION_STALE });
    expect(calls).toEqual([]);
  });

  it("refuses a managed pane's write with NO generation (the contract requires it there)", async () => {
    getInputGenerationStore(dataDir).record(S1, 1);
    const { ctx, calls } = makeCtx({ sendInput: () => {} });
    const result = await dispatchRaw(ctx, { type: "input", subshellId: S1, data: "x" });
    expect(result).toEqual({ ok: false, error: NODE_RESULT_SSH_GENERATION_STALE });
    expect(calls).toEqual([]);
  });

  it("accepts equal and higher generations", async () => {
    const store = getInputGenerationStore(dataDir);
    store.record(S1, 2);
    const { ctx, calls } = makeCtx({ sendInput: () => {} });
    expect(await dispatchRaw(ctx, { type: "input", subshellId: S1, data: "a", inputGeneration: 2 })).toEqual({
      ok: true,
    });
    expect(await dispatchRaw(ctx, { type: "input", subshellId: S1, data: "b", inputGeneration: 3 })).toEqual({
      ok: true,
    });
    expect(calls.filter((c) => c.method === "sendInput")).toHaveLength(2);
  });

  it("an ordinary pane (no record) writes untouched, generation present or not", async () => {
    const { ctx, calls } = makeCtx({ sendInput: () => {} });
    expect(await dispatchRaw(ctx, { type: "input", subshellId: S2, data: "a" })).toEqual({ ok: true });
    expect(await dispatchRaw(ctx, { type: "input", subshellId: S2, data: "b", inputGeneration: 9 })).toEqual({
      ok: true,
    });
  });
});

describe("prompt_deliver generation fence", () => {
  it("refuses before the settle wait: a fenced prompt never captures, never types", async () => {
    getInputGenerationStore(dataDir).record(S1, 2);
    const { ctx, calls } = makeCtx({ capturePane: () => "screen", sendInput: () => {}, pressEnter: () => {} });
    const result = await dispatchRaw(ctx, {
      type: "prompt_deliver",
      subshellId: S1,
      text: "hello",
      settleTimeoutMs: 50,
      pollMs: 10,
      inputGeneration: 1,
    });
    expect(result).toEqual({ ok: false, error: NODE_RESULT_SSH_GENERATION_STALE });
    expect(calls).toEqual([]);
  });

  it("refuses a managed pane's prompt carrying no generation", async () => {
    getInputGenerationStore(dataDir).record(S1, 1);
    const { ctx, calls } = makeCtx({ capturePane: () => "screen", sendInput: () => {}, pressEnter: () => {} });
    const result = await dispatchRaw(ctx, {
      type: "prompt_deliver",
      subshellId: S1,
      text: "hello",
      settleTimeoutMs: 50,
      pollMs: 10,
    });
    expect(result).toEqual({ ok: false, error: NODE_RESULT_SSH_GENERATION_STALE });
    expect(calls).toEqual([]);
  });

  it("a current generation still settles and types (ordinary behavior preserved for managed panes at the right generation)", async () => {
    const store = getInputGenerationStore(dataDir);
    store.record(S1, 3);
    const typed: string[] = [];
    const { ctx, calls } = makeCtx({
      capturePane: () => "screen",
      sendInput: (_s: unknown, _i: unknown, data: unknown) => {
        typed.push(String(data));
      },
      pressEnter: () => {},
    });
    const result = await dispatchRaw(ctx, {
      type: "prompt_deliver",
      subshellId: S1,
      text: "hello",
      settleTimeoutMs: 200,
      pollMs: 10,
      inputGeneration: 3,
    });
    expect(result).toEqual({ ok: true, data: { promptDelivered: true } });
    expect(typed).toEqual(["hello"]);
  });
});

describe("the frozen refusal spelling", () => {
  beforeEach(() => {
    expect(NODE_RESULT_SSH_GENERATION_STALE).toBe("stale input generation");
  });

  it("answers every fenced write with that spelling verbatim", async () => {
    getInputGenerationStore(dataDir).record(S1, 5);
    const { ctx, calls } = makeCtx({ sendInput: () => {} });
    const result = await dispatchRaw(ctx, { type: "input", subshellId: S1, data: "x", inputGeneration: 4 });
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("stale input generation");
  });
});
