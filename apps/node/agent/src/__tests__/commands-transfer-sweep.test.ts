import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../commands/context.js";
import { ensureTransfersDir } from "../commands/staging-dir.js";
import { sweepStaleTransfers } from "../commands/transfer-sweep.js";

/**
 * The staging sweep (spec 2026-10-01 review): an aborted transfer whose
 * plane-side `remove_paths` never landed leaves an archive (or its `.part`)
 * under `<dataDir>/transfers/`, and only THIS pass reclaims it. Pinned: old
 * staging and old temps go, a young in-flight stream stays, foreign names and
 * subdirectories are never touched, and a node that never transferred is a
 * silent no-op.
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-transfer-sweep-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function ctxFor(dataDir: string, nowMs: number): CommandContext {
  return {
    config: {
      serverUrl: "http://localhost:1",
      nodeId: "node-1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "test-node",
    },
    tmux: {} as CommandContext["tmux"],
    meta: {} as CommandContext["meta"],
    nowMs: () => nowMs,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
}

const HOUR = 60 * 60 * 1000;

function age(path: string, msAgo: number, nowMs: number): void {
  const when = new Date(nowMs - msAgo);
  utimesSync(path, when, when);
}

describe("sweepStaleTransfers", () => {
  it("deletes aged staging and its .part, keeps a young stream and foreign names", async () => {
    const dataDir = join(base, "mixed");
    const now = Date.now();
    const transfers = ensureTransfersDir(dataDir);
    const oldArchive = join(transfers, "11111111-1111-1111-1111-111111111111.tar.gz");
    const oldPart = join(transfers, ".22222222-2222-2222-2222-222222222222.tar.gz.part");
    const freshArchive = join(transfers, "33333333-3333-3333-3333-333333333333.tar.gz");
    writeFileSync(oldArchive, "old");
    writeFileSync(oldPart, "old-part");
    writeFileSync(freshArchive, "live-stream");
    const foreign = join(transfers, "not-ours.txt");
    writeFileSync(foreign, "leave me");
    const subDir = join(transfers, "subdir");
    mkdirSync(subDir);
    age(oldArchive, 2 * HOUR, now);
    age(oldPart, 2 * HOUR, now);
    age(foreign, 2 * HOUR, now);

    await sweepStaleTransfers(ctxFor(dataDir, now));

    expect(existsSync(oldArchive)).toBe(false); // aged staging reclaimed
    expect(existsSync(oldPart)).toBe(false); // aged temp reclaimed
    expect(existsSync(freshArchive)).toBe(true); // under an hour: possibly live, stays
    expect(existsSync(foreign)).toBe(true); // not our naming, never touched
    expect(existsSync(subDir)).toBe(true); // a stray dir is not ours to recurse
  });

  it("is a silent no-op when the node has never transferred", async () => {
    const dataDir = join(base, "empty");
    mkdirSync(dataDir, { recursive: true });
    await sweepStaleTransfers(ctxFor(dataDir, Date.now())); // no transfers/ dir: nothing, no throw
    expect(existsSync(join(dataDir, "transfers"))).toBe(false); // it does not create one either
  });

  it("never chases a planted symlink out of the staging dir", async () => {
    const dataDir = join(base, "symlink");
    const now = Date.now();
    const transfers = ensureTransfersDir(dataDir);
    const victim = join(base, "symlink-victim.tar.gz");
    writeFileSync(victim, "someone else's file");
    const link = join(transfers, "44444444-4444-4444-4444-444444444444.tar.gz");
    symlinkSync(victim, link);
    age(link, 2 * HOUR, now); // lstat age is the link's own; the target must survive

    await sweepStaleTransfers(ctxFor(dataDir, now));

    expect(existsSync(victim)).toBe(true); // the target was never touched
    expect(existsSync(link)).toBe(true); // lstat says symlink, not a file: skipped
  });
});
