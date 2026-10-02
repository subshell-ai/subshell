import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MANIFEST_PAGE_ENTRIES, parseNodeTreeManifestPage } from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * Spec 2026-10-01 §4: `tree_manifest` is the sync's diff input - sorted,
 * paged, sha256-keyed rows the plane compares against the other node's. The
 * cursor contract (STRICTLY after the last returned relPath, page-boundary
 * walks that resume without dup or skip) is what a two-page test below pins.
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-tree-manifest-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup(tag: string): { dataDir: string; work: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  for (const d of [dataDir, work]) mkdirSync(d, { recursive: true });
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  return {
    dataDir,
    work,
    ctx: {
      config,
      tmux: {} as CommandContext["tmux"],
      meta: new SubshellMetaStore(dataDir),
      nowMs: () => Date.now(),
      ws: { send: () => {} },
      watchers: new Map(),
      tails: new Map(),
      uploads: new Map(),
      runtime: null,
      requestRestart: () => {},
    },
  };
}

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function manifest(ctx: CommandContext, root: string, cursor?: string | null, maxBytes = 64 * 1024) {
  const res = await dispatchCommand(ctx, { type: "tree_manifest", root, ...(cursor ? { cursor } : {}), maxBytes });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("manifest ok");
  const page = parseNodeTreeManifestPage(res.data);
  expect(page).not.toBeNull();
  return page!;
}

describe("tree_manifest", () => {
  it("walks sorted rows with real digests; symlinks and dirs do not appear", async () => {
    const { work, ctx } = setup("walk");
    mkdirSync(join(work, "a", "b"), { recursive: true });
    writeFileSync(join(work, "a", "b", "deep.txt"), "deep\n");
    writeFileSync(join(work, "a.txt"), "flat\n");
    writeFileSync(join(work, "empty.txt"), "");
    symlinkSync(join(work, "a.txt"), join(work, "link.txt")); // the walk's skip list
    const page = await manifest(ctx, work);
    expect(page!.nextCursor).toBeNull(); // small tree, one page
    expect(page!.entries.map((e) => e.relPath)).toEqual(["a.txt", "a/b/deep.txt", "empty.txt"]);
    expect(page!.entries.map((e) => e.sha256)).toEqual([
      sha(readFileSync(join(work, "a.txt"))),
      sha(readFileSync(join(work, "a", "b", "deep.txt"))),
      sha(new Uint8Array(0)),
    ]);
    expect(page!.entries.find((e) => e.relPath === "empty.txt")!.size).toBe(0);
    expect(page!.entries.find((e) => e.relPath === "a.txt")!.mtime).toBeGreaterThan(0);
  });

  it("pages by the byte budget and resumes strictly after the cursor", async () => {
    const { work, ctx } = setup("paging");
    for (let i = 0; i < 6; i++) writeFileSync(join(work, `f${i}.txt`), "x".repeat(200));
    // A budget that fits exactly two rows (estimate is ~310 each):
    const first = await manifest(ctx, work, undefined, 640);
    expect(first!.entries.length).toBeGreaterThanOrEqual(1);
    expect(first!.entries.length).toBeLessThan(6);
    expect(first!.nextCursor).toBe(first!.entries.at(-1)!.relPath);
    const second = await manifest(ctx, work, first!.nextCursor, 640);
    expect(second!.entries.length).toBeGreaterThan(0);
    const seen = [...first!.entries, ...second!.entries].map((e) => e.relPath);
    expect(new Set(seen).size).toBe(seen.length); // no dup across the boundary
    // Drain the rest and prove the union is exactly the sorted full walk.
    let all = [...first!.entries, ...second!.entries];
    let cursor = second!.nextCursor;
    while (cursor !== null) {
      const nx = await manifest(ctx, work, cursor, 640);
      all = [...all, ...nx!.entries];
      cursor = nx!.nextCursor;
    }
    expect(all.map((e) => e.relPath)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `f${i}.txt`));
  });

  it("caps a page at MAX_MANIFEST_PAGE_ENTRIES rows and a cursor past the end answers empty", async () => {
    const { work, ctx } = setup("cap");
    for (let i = 0; i < MAX_MANIFEST_PAGE_ENTRIES + 1; i++)
      writeFileSync(join(work, `k${String(i).padStart(4, "0")}.txt`), "s");
    const first = await manifest(ctx, work, undefined, 64 * 1024);
    expect(first!.entries.length).toBe(MAX_MANIFEST_PAGE_ENTRIES); // entry cap binds before the budget
    expect(first!.nextCursor).toBe(`k${String(MAX_MANIFEST_PAGE_ENTRIES - 1).padStart(4, "0")}.txt`);
    const second = await manifest(ctx, work, first!.nextCursor, 64 * 1024);
    expect(second!.entries.map((e) => e.relPath)).toEqual([
      `k${String(MAX_MANIFEST_PAGE_ENTRIES).padStart(4, "0")}.txt`,
    ]);
    expect(second!.nextCursor).toBeNull();
    const past = await manifest(ctx, work, "zzzz");
    expect(past).toEqual({ entries: [], nextCursor: null });
  });

  it("is allowlist-gated on root", async () => {
    const { dataDir, work, ctx } = setup("gate");
    writeFileSync(join(work, "f.txt"), "x");
    writeAllowedDirs(dataDir, [join(base, "elsewhere")]);
    const res = await dispatchCommand(ctx, { type: "tree_manifest", root: work, maxBytes: 4096 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("allowed directories");
  });
});
