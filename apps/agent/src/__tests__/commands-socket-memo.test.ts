import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxSocketFor } from "@internal/harnesses";
import type { NodeEvent } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { AgentConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * The socket memo (simplify wave, spec §6.3): `resolveSocket` used to re-read
 * and re-parse the subshell's meta JSON on EVERY input/resize/capture command
 * — a filesystem hit per keystroke. The meta file now feeds an in-memory
 * mirror (populated on record, fed lazily by the restart-case fallback,
 * evicted on forget). The read count is proven with the mutate-the-file trick:
 * a second read would answer the sentinel socket, so seeing the recorded
 * socket across repeated commands means the file was read exactly once.
 */

const S = "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f";

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-socket-memo-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function metaJson(socket: string): string {
  return `${JSON.stringify({
    subshellId: S,
    cwd: base,
    socket,
    harnessId: "pi",
    name: "m",
    startedAt: "2026-09-01T00:00:00.000Z",
  })}\n`;
}

describe("resolveSocket memo (spec §6.3)", () => {
  it("reads the meta file exactly once across repeated input commands", async () => {
    const dataDir = join(base, "once");
    mkdirSync(dataDir, { recursive: true });

    // Record through a FIRST store, then drop it: the surviving meta file is
    // the agent-restart case — the daemon's own store never saw the record,
    // so its first lookup must fall back to the file (read #1)…
    await new SubshellMetaStore(dataDir).record({
      subshellId: S,
      cwd: base,
      socket: "memo-sock",
      harnessId: "pi",
      name: "m",
      startedAt: "2026-09-01T00:00:00.000Z",
    });

    const sends: Array<[string, string, string]> = [];
    const config: AgentConfig = {
      serverUrl: "http://localhost:1",
      nodeId: "node-1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "memo-node",
    };
    const ctx: CommandContext = {
      config,
      tmux: {
        sendInput: (socket: string, id: string, data: string) => {
          sends.push([socket, id, data]);
        },
      } as unknown as CommandContext["tmux"],
      meta: new SubshellMetaStore(dataDir),
      nowMs: () => 1_700_000_000_000,
      ws: { send: (_ev: NodeEvent) => {} },
      watchers: new Map(),
      tails: new Map(),
      uploads: new Map(),
    };

    expect(await dispatchCommand(ctx, { type: "input", subshellId: S, data: "a" })).toEqual({ ok: true });
    expect(sends).toEqual([["memo-sock", S, "a"]]); // the fallback DID read the file (only source of memo-sock)

    // …and every later command must NOT. Mutate the file behind the store's
    // back: a per-command re-read would now answer `sentinel-sock`.
    writeFileSync(join(dataDir, "subshells", `${S}.meta.json`), metaJson("sentinel-sock"));
    expect(await dispatchCommand(ctx, { type: "input", subshellId: S, data: "b" })).toEqual({ ok: true });
    expect(await dispatchCommand(ctx, { type: "input", subshellId: S, data: "c" })).toEqual({ ok: true });
    expect(sends).toEqual([
      ["memo-sock", S, "a"],
      ["memo-sock", S, "b"],
      ["memo-sock", S, "c"],
    ]); // never `sentinel-sock` ⇒ the meta file was read exactly once

    // Eviction on forget: after the record is gone the next lookup must NOT
    // answer the memoized socket — re-read finds nothing, orphan fallback wins.
    await ctx.meta.forget(S);
    expect(await dispatchCommand(ctx, { type: "input", subshellId: S, data: "d" })).toEqual({ ok: true });
    expect(sends[3]).toEqual([tmuxSocketFor(S), S, "d"]);
  });
});
