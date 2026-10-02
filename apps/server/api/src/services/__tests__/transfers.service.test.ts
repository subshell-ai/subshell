import { describe, expect, it } from "bun:test";
import { ApiError, BackendErrorCodes } from "@internal/backend-errors";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { runTransfer } from "@/services/transfers.service.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The transfer relay on the REAL RPC chain (spec 2026-10-01 §5): scripted
 * nodes answer the five verbs the way the agent's own suites prove it answers,
 * and this suite pins the WIRE CONTRACT the service owes them - exact
 * cmd-type censuses (create first, read/write windows alternating, eof last,
 * remove_paths cleanup on both success and abort), the staging paths the
 * plane mints under each node's reported dataDir, and the digest
 * verification that must precede any `archive_extract`.
 */

const SRC = "node-src";
const DST = "node-dst";
const SRC_DATA = "/home/src/.subshell";
const DST_DATA = "/home/dst/.subshell";

const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A scripted source node: builds the fake archive, serves honest windows. */
function scriptSource(
  archive: Uint8Array,
  opts: { corruptWindows?: boolean; stallAt?: number } = {},
): {
  node: ScriptedNode;
  removed: string[][];
} {
  const removed: string[][] = [];
  const node = attachScriptedNode(
    SRC,
    {
      archive_create: (cmd) => {
        if (cmd.type !== "archive_create") throw new Error("wrong cmd");
        return { size: archive.byteLength, sha256: sha256Hex(archive) };
      },
      file_read: (cmd) => {
        if (cmd.type !== "file_read") throw new Error("wrong cmd");
        const base = opts.corruptWindows ? new Uint8Array(archive.byteLength).fill(0xff) : archive;
        const slice = base.subarray(cmd.fromByte, Math.min(cmd.fromByte + cmd.maxBytes, archive.byteLength));
        // A source that answers without advancing the cursor would spin the
        // relay forever; the service must refuse it, not loop.
        const next = opts.stallAt === cmd.fromByte ? cmd.fromByte : cmd.fromByte + slice.byteLength;
        return {
          bytes_b64: Buffer.from(slice).toString("base64"),
          next,
          size: archive.byteLength,
        };
      },
      tree_manifest: (cmd) => {
        if (cmd.type !== "tree_manifest") throw new Error("wrong cmd");
        return { entries: manifestRows, nextCursor: null };
      },
      remove_paths: (cmd) => {
        if (cmd.type !== "remove_paths") throw new Error("wrong cmd");
        removed.push(cmd.paths);
        return undefined;
      },
    },
    { dataDir: SRC_DATA },
  );
  return { node, removed };
}

/**
 * A scripted destination: accumulates `transfer_write` chunks (asserting the
 * in-order contract itself), remembers the renamed whole, answers extract.
 */
function scriptDestination(opts: { failAtChunk?: number; manifest?: "present" | "missing" | "identical" } = {}): {
  node: ScriptedNode;
  removed: string[][];
  writes: { path: string; chunk: number; eof: boolean; bytes: number }[];
  extracted: () => { archivePath: string; expectedSha256: string; destRoot: string } | undefined;
  landed: () => Uint8Array;
} {
  const removed: string[][] = [];
  const writes: { path: string; chunk: number; eof: boolean; bytes: number }[] = [];
  const chunks: Uint8Array[] = [];
  let extractCmd: { archivePath: string; expectedSha256: string; destRoot: string } | undefined;
  const node = attachScriptedNode(
    DST,
    {
      transfer_write: (cmd) => {
        if (cmd.type !== "transfer_write") throw new Error("wrong cmd");
        const bytes = Buffer.from(cmd.chunkB64, "base64");
        if (opts.failAtChunk === cmd.chunk) throw new Error("disk full");
        writes.push({ path: cmd.path, chunk: cmd.chunk, eof: cmd.eof, bytes: bytes.byteLength });
        chunks[cmd.chunk] = new Uint8Array(bytes);
        const total = writes.reduce((n, w) => n + w.bytes, 0);
        return { path: cmd.path, received: total };
      },
      archive_extract: (cmd) => {
        if (cmd.type !== "archive_extract") throw new Error("wrong cmd");
        extractCmd = { archivePath: cmd.archivePath, expectedSha256: cmd.expectedSha256, destRoot: cmd.destRoot };
        return { files: 7, bytes: 12345 };
      },
      tree_manifest: (cmd) => {
        if (cmd.type !== "tree_manifest") throw new Error("wrong cmd");
        if (opts.manifest === "missing")
          throw new Error("tree_manifest could not read the tree: ENOENT: no such file or directory");
        if (opts.manifest === "identical") return { entries: manifestRows, nextCursor: null };
        return { entries: [], nextCursor: null };
      },
      remove_paths: (cmd) => {
        if (cmd.type !== "remove_paths") throw new Error("wrong cmd");
        removed.push(cmd.paths);
        return undefined;
      },
    },
    { dataDir: DST_DATA },
  );
  return {
    node,
    removed,
    writes,
    extracted: () => extractCmd,
    landed: () => {
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let off = 0;
      for (const c of chunks) {
        joined.set(c, off);
        off += c.byteLength;
      }
      return joined;
    },
  };
}

/** Shared manifest fixture: two rows with real 64-hex digests. */
const manifestRows = [
  { relPath: "a.txt", size: 4, mtime: 1_700_000_000, sha256: "a".repeat(64) },
  { relPath: "b/c.txt", size: 9, mtime: 1_700_000_001, sha256: "b".repeat(64) },
];

describe("transfers relay", () => {
  it("copy: exact census, staged under each node's dataDir, whole bytes land", async () => {
    const archive = new Uint8Array(1_300_000).map((_, i) => i & 0xff); // three 512 KiB windows
    const src = scriptSource(archive);
    const dst = scriptDestination();
    try {
      const result = await runTransfer({
        from: { nodeId: SRC, path: "/data/src" },
        to: { nodeId: DST, path: "/data/dst" },
        sync: false,
      });
      expect(result).toEqual({ sync: false, archiveBytes: archive.byteLength, files: 7, bytes: 12345, changed: 0 });

      expect(src.node.cmdTypes()).toEqual(["archive_create", "file_read", "file_read", "file_read", "remove_paths"]);
      expect(dst.node.cmdTypes()).toEqual([
        "transfer_write",
        "transfer_write",
        "transfer_write",
        "archive_extract",
        "remove_paths",
      ]);

      const creates = src.node.cmdsOf("archive_create");
      expect(creates.length).toBe(1);
      expect(creates[0]!.root).toBe("/data/src");
      expect(creates[0]!.files).toBeUndefined(); // whole-tree copy carries no list
      expect(creates[0]!.stagingPath.startsWith(`${SRC_DATA}/transfers/`)).toBe(true);
      expect(creates[0]!.stagingPath.endsWith(".tar.gz")).toBe(true);

      const reads = src.node.cmdsOf("file_read");
      expect(reads.map((r) => r.fromByte)).toEqual([0, 512 * 1024, 1024 * 1024]);
      expect(reads.every((r) => r.maxBytes === 512 * 1024)).toBe(true);
      expect(reads.every((r) => r.path === creates[0]!.stagingPath)).toBe(true);

      expect(dst.writes.map((w) => w.chunk)).toEqual([0, 1, 2]);
      expect(dst.writes.map((w) => w.eof)).toEqual([false, false, true]);
      expect(dst.writes.every((w) => w.path.startsWith(`${DST_DATA}/transfers/`))).toBe(true);
      expect(dst.landed()).toEqual(archive); // the exact bytes, in order

      const extract = dst.extracted();
      expect(extract?.archivePath).toBe(dst.writes[0]!.path); // extract reads what wrote landed
      expect(extract?.expectedSha256).toBe(sha256Hex(archive)); // the source's digest rides to the destination's re-check
      expect(extract?.destRoot).toBe("/data/dst");

      // Both stagings cleaned, source first (its create is the bigger file).
      expect(src.removed).toEqual([[creates[0]!.stagingPath]]);
      expect(dst.removed).toEqual([[dst.writes[0]!.path]]);
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("a mismatched digest aborts BEFORE extract and cleans the destination .part", async () => {
    const archive = new Uint8Array(2048).fill(3);
    const src = scriptSource(archive, { corruptWindows: true }); // honest size, wrong bytes
    const dst = scriptDestination();
    try {
      await expect(
        runTransfer({ from: { nodeId: SRC, path: "/a" }, to: { nodeId: DST, path: "/b" }, sync: false }),
      ).rejects.toThrow(/did not match the source's digest/);
      expect(dst.node.cmdTypes()).toEqual(["transfer_write", "remove_paths"]); // NO archive_extract
      expect(dst.removed[0]!.length).toBe(2);
      expect(dst.removed[0]![0]!.endsWith(".tar.gz")).toBe(true);
      expect(dst.removed[0]![1]).toBe(
        `${dst.removed[0]![0]!.slice(0, dst.removed[0]![0]!.lastIndexOf("/") + 1)}.${dst.removed[0]![0]!.slice(dst.removed[0]![0]!.lastIndexOf("/") + 1)}.part`,
      );
      expect(src.removed.length).toBe(1);
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("a source that answers without advancing the cursor aborts instead of spinning", async () => {
    // The relay's termination reads `next`; a source that keeps answering the
    // SAME cursor would re-relay a window forever, so the service refuses it
    // (a misbehaving node is an error, not an infinite loop).
    const archive = new Uint8Array(2048).fill(3);
    const src = scriptSource(archive, { stallAt: 0 });
    const dst = scriptDestination();
    try {
      const err = await runTransfer({
        from: { nodeId: SRC, path: "/a" },
        to: { nodeId: DST, path: "/b" },
        sync: false,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toMatch(/without advancing the cursor/);
      // The window never reached the destination (only the abort cleanup did):
      expect(dst.node.cmdTypes()).toEqual(["remove_paths"]);
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("a manifest whose cursor never advances is refused, not paged forever", async () => {
    // collectManifest's termination reads `nextCursor`; one that repeats the
    // cursor would grow plane memory unbounded. The cursor guard is the only
    // thing between a broken node and an infinite sync.
    const src = attachScriptedNode(
      SRC,
      {
        tree_manifest: () => ({
          entries: [{ relPath: "z", size: 1, mtime: 0, sha256: "a".repeat(64) }],
          nextCursor: "z", // never moves past itself
        }),
      },
      { dataDir: SRC_DATA },
    );
    try {
      const err = await runTransfer({
        from: { nodeId: SRC, path: "/a" },
        to: { nodeId: DST, path: "/b" },
        sync: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toMatch(/malformed payload/);
      // The destination was never asked (the source manifest failed first):
      expect(src.cmdTypes()).toEqual(["tree_manifest", "tree_manifest"]);
    } finally {
      src.detach();
    }
  });

  it("a mid-relay write failure aborts with cleanup on both ends, extract never sent", async () => {
    const archive = new Uint8Array(1_300_000).map((_, i) => i & 0xff);
    const src = scriptSource(archive);
    const dst = scriptDestination({ failAtChunk: 1 });
    try {
      const err = await runTransfer({
        from: { nodeId: SRC, path: "/a" },
        to: { nodeId: DST, path: "/b" },
        sync: false,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(BackendErrorCodes.NODE_UNREACHABLE);
      // chunk 1 arrives (and fails its handler), chunk 2 never sent; the wire
      // records refused commands too - that is how the loop saw the failure.
      expect(dst.node.cmdTypes()).toEqual(["transfer_write", "transfer_write", "remove_paths"]);
      expect(src.node.cmdTypes()).toEqual(["archive_create", "file_read", "file_read", "remove_paths"]); // one read per write attempt
      expect(src.removed[0]!.length).toBe(1);
      expect(dst.removed[0]!.length).toBe(2); // staging + its .part
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("sync: ships only the changed rows in the files list", async () => {
    const archive = new Uint8Array(16).fill(9);
    const src = scriptSource(archive);
    // Destination holds a.txt identical and NO b/c.txt: one changed row.
    const dst = attachScriptedNode(
      DST,
      {
        tree_manifest: () => ({ entries: [manifestRows[0]!], nextCursor: null }),
        transfer_write: (cmd: NodeCommandBody) =>
          cmd.type === "transfer_write"
            ? { path: cmd.path, received: Buffer.from(cmd.chunkB64, "base64").byteLength }
            : new Error("wrong"),
        archive_extract: () => ({ files: 1, bytes: 9 }),
        remove_paths: () => undefined,
      },
      { dataDir: DST_DATA },
    );
    try {
      const result = await runTransfer({
        from: { nodeId: SRC, path: "/data/src" },
        to: { nodeId: DST, path: "/data/dst" },
        sync: true,
      });
      expect(result).toEqual({ sync: true, archiveBytes: 16, files: 1, bytes: 9, changed: 1 });
      const creates = src.node.cmdsOf("archive_create");
      expect(creates[0]!.files).toEqual(["b/c.txt"]); // exactly the diff, sorted
      expect(src.node.cmdTypes()).toEqual(["tree_manifest", "archive_create", "file_read", "remove_paths"]);
    } finally {
      src.node.detach();
      dst.detach();
    }
  });

  it("sync onto a destination whose root does not exist yet is the first copy, not an error", async () => {
    const archive = new Uint8Array(16).fill(9);
    const src = scriptSource(archive);
    const dst = scriptDestination({ manifest: "missing" });
    try {
      const result = await runTransfer({
        from: { nodeId: SRC, path: "/data/src" },
        to: { nodeId: DST, path: "/data/new" },
        sync: true,
      });
      expect(result.changed).toBe(2);
      expect(src.node.cmdsOf("archive_create")[0]!.files).toEqual(["a.txt", "b/c.txt"]);
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("a sync with nothing changed moves no archive at all", async () => {
    const archive = new Uint8Array(16).fill(9);
    const src = scriptSource(archive);
    const dst = scriptDestination({ manifest: "identical" });
    try {
      const result = await runTransfer({
        from: { nodeId: SRC, path: "/a" },
        to: { nodeId: DST, path: "/b" },
        sync: true,
      });
      expect(result).toEqual({ sync: true, archiveBytes: 0, files: 0, bytes: 0, changed: 0 });
      expect(src.node.cmdTypes()).toEqual(["tree_manifest"]);
      expect(dst.node.cmdTypes()).toEqual(["tree_manifest"]);
    } finally {
      src.node.detach();
      dst.node.detach();
    }
  });

  it("an agent that answers unsupported is refused with the update remedy named", async () => {
    // The dispatch default arm's contract word, verbatim: `resolveResult`
    // turns exactly this answer into the `unsupported` RPC code (node-rpc
    // §"agent answers error:'unsupported'"), which the service must map to
    // the NODE_AGENT_TOO_OLD code whose sentence names updating the node
    // (spec 2026-10-01 §5 R12 - the word alone is otherwise cryptic).
    const src = attachScriptedNode(SRC, { archive_create: () => new Error("unsupported") }, { dataDir: SRC_DATA });
    const dst = attachScriptedNode(DST, {}, { dataDir: DST_DATA }); // exists; nothing should ever reach it
    try {
      const err = await runTransfer({
        from: { nodeId: SRC, path: "/a" },
        to: { nodeId: DST, path: "/b" },
        sync: false,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(BackendErrorCodes.NODE_AGENT_TOO_OLD);
      expect((err as ApiError).message).toContain("update the node");
      expect(dst.cmdTypes()).toEqual([]); // the refusal answered before any destination frame
    } finally {
      src.detach();
      dst.detach();
    }
  });
});
