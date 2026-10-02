import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TRANSFER_WINDOW_BYTES,
  parseNodeFileReadResult,
  parseNodeWriteFileResult,
} from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * Spec 2026-10-01 §4, the two window verbs: `file_read` (generalized
 * `log_read` under the OPERATOR allowlist) and `transfer_write` (`write_file`'s
 * stream discipline under the same allowlist instead of the upload roots).
 * Both go through `dispatchCommand` so the protocol-15 switch arms are part
 * of the proof, and every answer through the wire validator.
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-file-transfer-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup(tag: string): { dataDir: string; work: string; outside: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  const outside = join(root, "outside");
  for (const d of [dataDir, work, outside]) mkdirSync(d, { recursive: true });
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
    tmux: {} as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => Date.now(),
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
  return { dataDir, work, outside, ctx };
}

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const unb64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

describe("file_read", () => {
  it("serves windows with the log_read cursor grammar, validator-shaped", async () => {
    const { work, ctx } = setup("windows");
    const path = join(work, "f.bin");
    writeFileSync(path, "0123456789");
    const read = (fromByte: number, maxBytes = 64 * 1024) =>
      dispatchCommand(ctx, { type: "file_read", path, fromByte, maxBytes });

    const first = await read(0, 4);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const w = parseNodeFileReadResult(first.data);
    if (!w) throw new Error("file_read answered an unparseable window");
    expect(unb64(w.bytes_b64)).toBe("0123");
    expect(w.next).toBe(4);
    expect(w.size).toBe(10);

    const at7 = await read(7);
    expect(at7.ok).toBe(true);
    if (!at7.ok) throw new Error("read at offset 7 accepted");
    const tail = parseNodeFileReadResult(at7.data);
    if (!tail) throw new Error("file_read answered an unparseable window");
    expect(unb64(tail.bytes_b64)).toBe("789");
    expect(tail.next).toBe(10);

    // At/past EOF: empty read, cursor parked at size (relay loop end).
    const atEof = parseNodeFileReadResult(((await read(10)) as { data: unknown }).data);
    expect(atEof).toEqual({ bytes_b64: "", next: 10, size: 10 });
    const past = parseNodeFileReadResult(((await read(99)) as { data: unknown }).data);
    expect(past).toEqual({ bytes_b64: "", next: 10, size: 10 });
  });

  it("missing files read as empty (size 0), never an error", async () => {
    const { work, ctx } = setup("missing");
    const res = await dispatchCommand(ctx, {
      type: "file_read",
      path: join(work, "gone.bin"),
      fromByte: 0,
      maxBytes: 1024,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(parseNodeFileReadResult(res.data)).toEqual({ bytes_b64: "", next: 0, size: 0 });
  });

  it("is gated by the operator allowlist, not by anything log-shaped", async () => {
    const { dataDir, work, ctx } = setup("gate");
    writeFileSync(join(work, "f.bin"), "abc");
    writeAllowedDirs(dataDir, [join(base, "somewhere-else")]); // a list that excludes work
    const res = await dispatchCommand(ctx, { type: "file_read", path: join(work, "f.bin"), fromByte: 0, maxBytes: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("allowed directories");
    // Pane logs live inside dataDir; a transfer read there is NOT this
    // command's world unless the allowlist says so (empty list = yes).
    writeAllowedDirs(dataDir, []);
    expect(
      (await dispatchCommand(ctx, { type: "file_read", path: join(work, "f.bin"), fromByte: 0, maxBytes: 8 })).ok,
    ).toBe(true);
  });

  it("admits the staging subtree under a restrictive list, and nothing else inside dataDir", async () => {
    // The M1 pin: the plane reads ONLY its own staging file, minted under
    // `<dataDir>/transfers/`; an operator list naming WORKING directories
    // must not strand the read (it used to: no configured node could ever
    // be a source). The subtree is the ONE state-dir concession - the node
    // signing key and the pane logs next door stay outside this verb, and
    // `log_read` stays the pane logs' only reader.
    const { dataDir, ctx } = setup("gate-staging");
    const transfers = join(dataDir, "transfers");
    mkdirSync(transfers, { recursive: true });
    writeFileSync(join(transfers, "relay.tar.gz"), "STAGED");
    writeFileSync(join(dataDir, "node-signing.json"), "secret");
    mkdirSync(join(dataDir, "subshells"), { recursive: true });
    writeFileSync(join(dataDir, "subshells", "s-1.log"), "typed secrets");
    writeAllowedDirs(dataDir, [join(base, "somewhere-else")]); // excludes dataDir entirely
    const staged = await dispatchCommand(ctx, {
      type: "file_read",
      path: join(transfers, "relay.tar.gz"),
      fromByte: 0,
      maxBytes: 64,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("staging read refused");
    expect(unb64(parseNodeFileReadResult(staged.data)?.bytes_b64 ?? "")).toBe("STAGED");
    for (const p of [join(dataDir, "node-signing.json"), join(dataDir, "subshells", "s-1.log")]) {
      const res = await dispatchCommand(ctx, { type: "file_read", path: p, fromByte: 0, maxBytes: 8 });
      expect(res.ok).toBe(false);
    }
    // And the admission is pathAllowed-hardened, not lexical: a symlink
    // planted INSIDE the staging dir does not smuggle a read from outside it.
    symlinkSync(join(dataDir, "node-signing.json"), join(transfers, "sneaky.tar.gz"));
    const chase = await dispatchCommand(ctx, {
      type: "file_read",
      path: join(transfers, "sneaky.tar.gz"),
      fromByte: 0,
      maxBytes: 64,
    });
    expect(chase.ok).toBe(false);
  });
});

describe("transfer_write", () => {
  it("streams chunks to a .part and renames once at eof, modes and totals validator-shaped", async () => {
    const { work, ctx } = setup("stream");
    const dest = join(work, "nested", "landed.bin");
    const part = join(work, "nested", ".landed.bin.part");
    const send = (chunkB64: string, chunk: number, eof = false) =>
      dispatchCommand(ctx, { type: "transfer_write", path: dest, chunkB64, chunk, eof });

    const c0 = await send(b64("AAA"), 0);
    expect(c0.ok).toBe(true);
    if (!c0.ok) return;
    expect(parseNodeWriteFileResult(c0.data)).toEqual({ path: dest, received: 3 });
    expect(existsSync(part)).toBe(true); // temp beside final
    expect(existsSync(dest)).toBe(false); // nothing lands before eof

    const c1 = await send(b64("BB"), 1);
    if (!c1.ok) throw new Error("chunk 1 accepted");
    const ack1 = parseNodeWriteFileResult(c1.data);
    if (!ack1) throw new Error("transfer_write answered an unparseable ack");
    expect(ack1.received).toBe(5);

    const last = await send(b64("C"), 2, true);
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(parseNodeWriteFileResult(last.data)).toEqual({ path: dest, received: 6 });
    expect(readFileSync(dest, "utf8")).toBe("AAABBC");
    expect(existsSync(part)).toBe(false);
    expect(lstatSync(dest).mode & 0o777).toBe(0o600);
  });

  it("refuses out-of-order chunks and oversized windows; restart heals", async () => {
    const { work, ctx } = setup("sequence");
    const dest = join(work, "seq.bin");
    const send = (chunkB64: string, chunk: number, eof = false) =>
      dispatchCommand(ctx, { type: "transfer_write", path: dest, chunkB64, chunk, eof });

    expect((await send(b64("A"), 0)).ok).toBe(true);
    const jumped = await send(b64("X"), 5);
    expect(jumped.ok).toBe(false);
    if (jumped.ok) return;
    expect(jumped.error).toBe("transfer_write chunk 5 has no open stream");
    // The stream stays open for the RIGHT index (redelivery contract):
    expect((await send(b64("B"), 1, true)).ok).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("AB");

    // A window past the protocol constant is refused before any side effect.
    const fat = await dispatchCommand(ctx, {
      type: "transfer_write",
      path: join(work, "fat.bin"),
      chunkB64: "A".repeat(Math.ceil(((MAX_TRANSFER_WINDOW_BYTES + 1) * 4) / 3)),
      chunk: 0,
      eof: false,
    });
    expect(fat.ok).toBe(false);
    if (fat.ok) return;
    expect(fat.error).toContain("transfer window");
    expect(existsSync(join(work, "fat.bin"))).toBe(false);
  });

  it("gates on the operator allowlist at chunk 0 AND re-gates at eof", async () => {
    const { dataDir, work, outside, ctx } = setup("policy");
    // Chunk 0: a refused destination writes nothing anywhere.
    writeAllowedDirs(dataDir, [outside]);
    const refused = await dispatchCommand(ctx, {
      type: "transfer_write",
      path: join(work, "no.bin"),
      chunkB64: b64("x"),
      chunk: 0,
      eof: true,
    });
    expect(refused.ok).toBe(false);
    expect(existsSync(join(work, "no.bin"))).toBe(false);
    expect(existsSync(join(work, ".no.bin.part"))).toBe(false);

    // eof re-check: allow chunk 0, then tighten the rules mid-stream — the
    // rename must NOT land what the fresh policy refuses.
    writeAllowedDirs(dataDir, []);
    const dest = join(work, "mid.bin");
    expect(
      (await dispatchCommand(ctx, { type: "transfer_write", path: dest, chunkB64: b64("A"), chunk: 0, eof: false })).ok,
    ).toBe(true);
    writeAllowedDirs(dataDir, [outside]);
    const eofFail = await dispatchCommand(ctx, {
      type: "transfer_write",
      path: dest,
      chunkB64: b64("B"),
      chunk: 1,
      eof: true,
    });
    expect(eofFail.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(work, ".mid.bin.part"))).toBe(false); // nothing stranded
  });

  it("admits its staging root: a dataDir target writes even when the list excludes it", async () => {
    const { dataDir, ctx } = setup("staging-in");
    // An operator list naming only some working dirs still lets the relay
    // land the archive under the node's own state root (spec 2026-10-01 §4).
    writeAllowedDirs(dataDir, [join(base, "some-work")]);
    const landed = join(dataDir, "transfers", "relay.tar.gz");
    const r = await dispatchCommand(ctx, {
      type: "transfer_write",
      path: landed,
      chunkB64: b64("ARCHIVE"),
      chunk: 0,
      eof: true,
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(landed, "utf8")).toBe("ARCHIVE");
  });

  it("refuses a symlink leaf planted mid-stream (the rename never chases it)", async () => {
    const { dataDir, work, ctx } = setup("symlink");
    // A NON-empty allowlist engages the hardened pathAllowed (an empty list
    // is unrestricted by ruling, where the OS-user boundary already decides).
    writeAllowedDirs(dataDir, [work]);
    const dest = join(work, "linkme.bin");
    const victim = join(work, "victim.txt");
    writeFileSync(victim, "original");
    expect(
      (await dispatchCommand(ctx, { type: "transfer_write", path: dest, chunkB64: b64("A"), chunk: 0, eof: false })).ok,
    ).toBe(true);
    // Somebody plants a symlink at the FINAL path mid-stream:
    symlinkSync(victim, dest);
    const eof = await dispatchCommand(ctx, {
      type: "transfer_write",
      path: dest,
      chunkB64: b64("B"),
      chunk: 1,
      eof: true,
    });
    expect(eof.ok).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("original"); // the eof gate refused; the rename never ran
    expect(lstatSync(dest).isSymbolicLink()).toBe(true); // the planted link still stands, nothing landed through it
    expect(existsSync(join(work, ".linkme.bin.part"))).toBe(false); // and the temp was discarded
  });
});
