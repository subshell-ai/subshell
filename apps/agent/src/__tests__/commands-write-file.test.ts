import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeCommandBody, parseNodeWriteFileResult } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { cleanupStaleUploads, execWriteFile } from "../commands/write-file.js";
import type { AgentConfig } from "../config.js";
import { SessionMetaStore } from "../session-meta.js";

/**
 * Task 6: the `write_file` chunk receiver (spec 2026-08-31 §3.4/§7). No tmux
 * at all — this executor is pure fs: every stream lands its bytes in a
 * `.<basename>.part` temp beside the FINAL path (created only after the
 * first-chunk policy pass), and `eof` re-runs the policy on FRESH roots
 * before the rename, so a symlink planted mid-stream cannot escape the
 * allowlist. Every chunk answer is run through the Task-1 validator
 * (`parseNodeWriteFileResult`) so the agent side can never drift from the
 * backend's expectations.
 */

const S1 = "11111111-1111-4111-8111-111111111111";

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-write-file-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Fresh dataDir + tracked cwd (`work`) + never-tracked `outside`, per test (tags isolate dirs). */
function setup(
  tag: string,
  nowMs = (): number => Date.now(),
): { dataDir: string; work: string; outside: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  const outside = join(root, "outside");
  for (const d of [dataDir, work, outside]) mkdirSync(d, { recursive: true });
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
    // write_file never touches tmux; a bare cast keeps the "unstubbed throws"
    // discipline of the other suites (any tmux call here is a test bug).
    tmux: {} as CommandContext["tmux"],
    meta: new SessionMetaStore(dataDir),
    nowMs,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
  };
  return { dataDir, work, outside, ctx };
}

/** Record `cwd` as a session launch dir so the policy roots include it. */
async function track(ctx: CommandContext, cwd: string, id = S1): Promise<void> {
  await ctx.meta.record({
    sessionId: id,
    cwd,
    socket: "test.sock",
    harnessId: "claude-code",
    name: "t",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}

/** One `write_file` frame carrying `text` (base64, as the wire delivers it). */
function chunkOf(path: string, text: string, n: number, eof: boolean): NodeCommandBody {
  return { type: "write_file", path, chunk_b64: Buffer.from(text, "utf8").toString("base64"), chunk: n, eof };
}

/* ------------------------------------------------------------------ */

describe("execWriteFile (spec §3.4)", () => {
  it("happy path: 2 chunks + eof into a recorded cwd's uploads dir — exact bytes, 0600, no .part left", async () => {
    const { work, ctx } = setup("happy");
    await track(ctx, work);
    const final = join(work, "uploads", "note.txt"); // `uploads` does not exist yet — chunk 0 creates it

    const r0 = await dispatchCommand(ctx, chunkOf(final, "AB", 0, false));
    expect(r0).toEqual({ ok: true, data: { path: final, received: 2 } });
    expect(parseNodeWriteFileResult((r0 as { data: unknown }).data)).not.toBeNull();
    // tmp lives beside the FINAL path, named .<basename>.part, and it is private
    expect(readdirSync(join(work, "uploads"))).toEqual([".note.txt.part"]);
    expect(statSync(join(work, "uploads", ".note.txt.part")).mode & 0o777).toBe(0o600);

    const r1 = await dispatchCommand(ctx, chunkOf(final, "CD", 1, true));
    expect(r1).toEqual({ ok: true, data: { path: final, received: 4 } });
    expect(readFileSync(final, "utf8")).toBe("ABCD");
    expect(statSync(final).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(work, "uploads"))).toEqual(["note.txt"]); // no temp survives eof
    expect(ctx.uploads.size).toBe(0); // stream state dropped at eof
  });

  it("a 1-byte file (chunk 0 + eof) lands exact, private, with no temp", async () => {
    const { work, ctx } = setup("one-byte");
    await track(ctx, work);
    const final = join(work, "x.bin");
    expect(await dispatchCommand(ctx, chunkOf(final, "x", 0, true))).toEqual({
      ok: true,
      data: { path: final, received: 1 },
    });
    expect(readFileSync(final, "utf8")).toBe("x");
    expect(statSync(final).mode & 0o777).toBe(0o600);
    expect(readdirSync(work).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("chunk N>0 with no open stream and out-of-order chunks answer the same error; the correct chunk still flows", async () => {
    const { work, ctx } = setup("order");
    await track(ctx, work);
    const lonely = join(work, "lonely.bin");
    expect(await dispatchCommand(ctx, chunkOf(lonely, "A", 1, false))).toEqual({
      ok: false,
      error: "write_file chunk 1 has no open stream",
    });

    const final = join(work, "stream.bin");
    expect(await dispatchCommand(ctx, chunkOf(final, "A", 0, false))).toEqual({
      ok: true,
      data: { path: final, received: 1 },
    });
    // a skipped index is the same "no open stream" answer — the stream stays
    // OPEN, so the control plane's redelivery of the right chunk still lands.
    expect(await dispatchCommand(ctx, chunkOf(final, "Z", 2, false))).toEqual({
      ok: false,
      error: "write_file chunk 2 has no open stream",
    });
    expect(await dispatchCommand(ctx, chunkOf(final, "B", 1, true))).toEqual({
      ok: true,
      data: { path: final, received: 2 },
    });
    expect(readFileSync(final, "utf8")).toBe("AB");
  });

  it("a path outside every root is refused with NO temp created (raw path and `..` collapse)", async () => {
    const { work, outside, ctx } = setup("refused");
    await track(ctx, work);

    expect(await dispatchCommand(ctx, chunkOf(join(outside, "x.bin"), "A", 0, false))).toEqual({
      ok: false,
      error: `path refused: ${join(outside, "x.bin")}`,
    });
    // the `..` variant must not slip through resolve()-and-prefix either
    expect(await dispatchCommand(ctx, chunkOf(join(work, "..", "outside", "y.bin"), "A", 0, false))).toEqual({
      ok: false,
      error: `path refused: ${join(work, "..", "outside", "y.bin")}`,
    });
    expect(readdirSync(outside)).toEqual([]); // refused ⇒ nothing written anywhere, not even a .part
    expect(ctx.uploads.size).toBe(0);
  });

  it("chunk 0 on an existing stream RESTARTS it: the old temp and its bytes are replaced", async () => {
    const { work, ctx } = setup("restart");
    await track(ctx, work);
    const final = join(work, "up.bin");
    await dispatchCommand(ctx, chunkOf(final, "OLD-CONTENT-IGNORED", 0, false));
    await dispatchCommand(ctx, chunkOf(final, "-trailing-junk", 1, false));
    // the stream "failed" mid-upload (the relay dropped); the control plane
    // reopens from chunk 0 — the half-written temp must not survive.
    const r = await dispatchCommand(ctx, chunkOf(final, "NEW", 0, true));
    expect(r).toEqual({ ok: true, data: { path: final, received: 3 } });
    expect(readFileSync(final, "utf8")).toBe("NEW");
    expect(readdirSync(work).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("a symlink planted under the cwd between chunk 0 and eof is caught by the eof re-check", async () => {
    const { work, outside, ctx } = setup("symlink");
    await track(ctx, work);
    const sub = join(work, "sub");
    const final = join(sub, "secret.txt");
    // chunk 0 passes: `sub` is inside the tracked cwd, fresh-made by the pass.
    expect(await dispatchCommand(ctx, chunkOf(final, "TOP", 0, false))).toEqual({
      ok: true,
      data: { path: final, received: 3 },
    });
    // mid-stream: the dir (with our .part inside it) is moved out and a
    // symlink stands in its place — the final path now resolves OUTSIDE roots.
    const moved = join(outside, "moved");
    renameSync(sub, moved);
    symlinkSync(moved, sub, "dir");

    const r = await dispatchCommand(ctx, chunkOf(final, "SECRET", 1, true));
    expect(r).toEqual({ ok: false, error: `path refused: ${final}` });
    expect(existsSync(join(moved, "secret.txt"))).toBe(false); // no escape-rename landed
    expect(readdirSync(moved)).toEqual([]); // and the stranded temp was deleted with it
    expect(ctx.uploads.size).toBe(0); // the dead stream is dropped, not left open
  });

  it("eof rename OVERWRITES an existing final (naming uniqueness is the control plane's job)", async () => {
    const { work, ctx } = setup("overwrite");
    await track(ctx, work);
    const final = join(work, "over.txt");
    writeFileSync(final, "a much older, longer body of bytes", { mode: 0o644 });
    expect(await dispatchCommand(ctx, chunkOf(final, "NEW", 0, true))).toEqual({
      ok: true,
      data: { path: final, received: 3 },
    });
    expect(readFileSync(final, "utf8")).toBe("NEW");
    expect(statSync(final).mode & 0o777).toBe(0o600); // re-tightened even over a 0644 overwrite
  });

  it("execWriteFile answers every success through the contract shape", async () => {
    const { work, ctx } = setup("contract");
    await track(ctx, work);
    const r = await execWriteFile(
      ctx,
      chunkOf(join(work, "c.txt"), "hello", 0, true) as Extract<NodeCommandBody, { type: "write_file" }>,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseNodeWriteFileResult(r.data)).toEqual({ path: join(work, "c.txt"), received: 5 });
  });
});

/* ------------------------------------------------------------------ */

describe("cleanupStaleUploads (daemon-start sweep)", () => {
  it("unlinks day-old .part temps in dataDir and tracked cwds; keeps fresh ones, non-temps, nested strays, and survives missing dirs", async () => {
    const now = Date.now();
    const { dataDir, work, ctx } = setup("sweep", () => now);
    await track(ctx, work);
    const goneDir = join(base, "sweep", "already-deleted");
    await track(ctx, goneDir, "22222222-2222-4222-8222-222222222222"); // cwd vanished — skip silently, never throw

    const old = now / 1000 - 7200; // 2 h ago, in POSIX seconds for utimes
    const staleInData = join(dataDir, ".upload-old.part");
    const staleInWork = join(work, ".stream-old.part");
    const fresh = join(work, ".stream-new.part");
    const wrongName = join(work, "orphan.part"); // no leading dot — not OUR temp naming
    const nested = join(work, "uploads");
    const nestedStray = join(nested, ".stray-old.part"); // deeper than the shallow sweep — stays
    mkdirSync(nested);
    for (const p of [staleInData, staleInWork, wrongName, nestedStray]) writeFileSync(p, "x");
    writeFileSync(fresh, "x");
    writeFileSync(join(work, "keep.txt"), "x");
    for (const p of [staleInData, staleInWork, wrongName, nestedStray]) utimesSync(p, old, old);

    await cleanupStaleUploads(ctx);

    expect(existsSync(staleInData)).toBe(false);
    expect(existsSync(staleInWork)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(wrongName)).toBe(true);
    expect(existsSync(nestedStray)).toBe(true); // sweep is deliberately shallow (cheaply enumerable)
    expect(existsSync(join(work, "keep.txt"))).toBe(true);
  });

  it("never throws: no dirs, no metas, and a file where a dir name was expected", async () => {
    const { ctx } = setup("sweep-quiet"); // empty dataDir/sessions → meta.list is []
    await cleanupStaleUploads(ctx); // must resolve, silently
    const { dataDir, ctx: ctx2 } = setup("sweep-noise");
    writeFileSync(join(dataDir, "sessions"), "not a directory"); // sessions path is a plain file
    await cleanupStaleUploads(ctx2);
    expect(existsSync(join(dataDir, "sessions"))).toBe(true); // untouched, unbothered
  });
});
