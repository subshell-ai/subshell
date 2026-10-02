import { randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import {
  MAX_MANIFEST_PAGE_BYTES,
  MAX_TRANSFER_LIST_FILES,
  MAX_TRANSFER_WINDOW_BYTES,
  type NodeCommandBody,
  type NodeManifestEntryWire,
  parseNodeArchiveCreateResult,
  parseNodeArchiveExtractResult,
  parseNodeFileReadResult,
  parseNodeTreeManifestPage,
  parseNodeWriteFileResult,
} from "@internal/subshell-protocol";
import { getLive } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The transfer relay (spec 2026-10-01 §5): the source node builds an archive
 * under its own data dir, the plane streams it window by window to the
 * destination node's data dir, and the destination extracts it into the
 * allowlisted root. The archive is OPAQUE in transit — the plane never parses
 * tar bytes, only relays them and re-hashes.
 *
 * Memory discipline is the point of the whole window design: exactly ONE
 * decoded window exists at a time (the uploads path's whole-buffer sniff is
 * the anti-pattern this must not meet — spec §5 R14). Every frame stays under
 * the wire's own ceiling because `MAX_TRANSFER_WINDOW_BYTES` is derived from
 * it (protocol §2; the uploads errata is the burned precedent).
 *
 * Transport trust: the digest `archive_create` reported is re-verified HERE,
 * incrementally over the windows as they pass, before `archive_extract` is
 * ever sent — the destination's guards decide whether the bytes are benign;
 * this loop is what proves they are the bytes the source wrote.
 *
 * Failure posture (v1): abort, best-effort `remove_paths` of staging and the
 * destination `.part`, and the error rides back. No resume, no transfer row
 * (spec §5) — a half tree is impossible (extract only ever sees a renamed
 * whole), a half archive is two named files and this module deletes them.
 */

/** Per-verb deadlines from the spec §2 table. */
const CREATE_TIMEOUT_MS = 300_000;
const EXTRACT_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 10_000;
const WRITE_CHUNK_TIMEOUT_MS = 30_000; // uploads' proven per-chunk budget, same shape
const MANIFEST_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Safety margin for a `files` list riding one command frame: the list is
 * serialized and measured HERE rather than trusted to the frame cap, because
 * the fallback (listless whole-tree create) is a PLANE decision — the agent
 * never sees a refusal it could give a better answer to (spec §2 R7).
 */
const LIST_JSON_BUDGET_BYTES = 512 * 1024;

/** One endpoint of a transfer: an absolute path ON the named agent node. */
export interface TransferEndpoint {
  /** The node's id (agent nodes only; the route refuses `local`). */
  nodeId: string;
  /** Absolute directory on that node; the node's allowlist is the authority. */
  path: string;
}

/** What a completed transfer reports. */
export interface TransferResult {
  /** True for the diff-sync flow. */
  sync: boolean;
  /** Compressed archive bytes relayed (0 for a no-op sync). */
  archiveBytes: number;
  /** Files extracted at the destination (0 for a no-op sync). */
  files: number;
  /** Uncompressed body bytes written at the destination. */
  bytes: number;
  /** Sync only: how many rows the diff marked changed. */
  changed: number;
}

/**
 * Copy (or diff-sync) `from.path` on one node to `to.path` on another. The
 * ROUTE has already gated both endpoints (ownership, `local`, maintenance,
 * liveness); everything in here is transport.
 *
 * @param args.from - source node + directory
 * @param args.to - destination node + directory (may not exist yet for sync)
 * @param args.sync - true to diff on per-file SHA-256 and ship only changes
 */
export async function runTransfer({
  from,
  to,
  sync,
}: {
  from: TransferEndpoint;
  to: TransferEndpoint;
  sync: boolean;
}): Promise<TransferResult> {
  if (sync) return await transferSync(from, to);
  return await transferCopy(from, to);
}

/** Whole-tree copy: create -> relay -> verify -> extract -> clean staging. */
async function transferCopy(from: TransferEndpoint, to: TransferEndpoint): Promise<TransferResult> {
  const relay = await relayArchive(from, to, undefined);
  return {
    sync: false,
    archiveBytes: relay.archiveBytes,
    files: relay.extract.files,
    bytes: relay.extract.bytes,
    changed: 0,
  };
}

/**
 * Diff-sync: page both manifests, compare on SHA-256 (mtime is a hint, never
 * the key - cross-machine clock skew, spec §4), and ship only the changed
 * rows. Extra files at the destination are left alone: additive by ruling.
 * A tree mutating mid-sync can dup or skip across pages; re-running is the
 * remedy, and this is where that sentence earns its keep.
 */
async function transferSync(from: TransferEndpoint, to: TransferEndpoint): Promise<TransferResult> {
  const src = await collectManifest(from);
  const dst = await collectManifest(to, true);
  const dstByKey = new Map(dst.map((e) => [e.relPath, e]));
  const changed = src.filter((e) => {
    const prior = dstByKey.get(e.relPath);
    return prior === undefined || prior.sha256 !== e.sha256 || prior.size !== e.size;
  });
  if (changed.length === 0) return { sync: true, archiveBytes: 0, files: 0, bytes: 0, changed: 0 };
  const list = changed.map((e) => e.relPath);
  // The list rides one frame; past either cap the honest answer is a
  // whole-tree create (spec §2 R7), not a refused transfer.
  const fitsFrame =
    list.length <= MAX_TRANSFER_LIST_FILES && Buffer.byteLength(JSON.stringify(list)) <= LIST_JSON_BUDGET_BYTES;
  const relay = await relayArchive(from, to, fitsFrame ? list : undefined);
  return {
    sync: true,
    archiveBytes: relay.archiveBytes,
    files: relay.extract.files,
    bytes: relay.extract.bytes,
    changed: changed.length,
  };
}

/**
 * The shared copy/sync spine: source-side create, windowed relay with
 * incremental digest verification, destination extract, staging cleanup on
 * both ends. Throws an ApiError (wire codes only; agent sentences ride the
 * message) on any failure, after best-effort cleanup.
 */
async function relayArchive(
  from: TransferEndpoint,
  to: TransferEndpoint,
  files: string[] | undefined,
): Promise<{ archiveBytes: number; extract: { files: number; bytes: number } }> {
  const fromStaging = stagingPathFor(from.nodeId);
  const toStaging = stagingPathFor(to.nodeId);
  const created = await nodeCommand(
    from.nodeId,
    { type: "archive_create", root: from.path, ...(files === undefined ? {} : { files }), stagingPath: fromStaging },
    CREATE_TIMEOUT_MS,
  ).catch((err: unknown) => {
    throw rethrowNodeError(err, from.nodeId, "archive_create");
  });
  const create = parseNodeArchiveCreateResult(created);
  if (create === null) return malformed(from.nodeId, "archive_create");

  try {
    await relayWindows(from.nodeId, to.nodeId, fromStaging, toStaging, create);
  } catch (err) {
    // Abort posture: the named temp files, nothing else (spec §5: no resume).
    await cleanupStaging(from.nodeId, [fromStaging]);
    await cleanupStaging(to.nodeId, [toStaging, partPathOf(toStaging)]);
    throw err;
  }
  await cleanupStaging(from.nodeId, [fromStaging]);

  let extract: ReturnType<typeof parseNodeArchiveExtractResult>;
  try {
    const data = await nodeCommand(
      to.nodeId,
      { type: "archive_extract", archivePath: toStaging, destRoot: to.path },
      EXTRACT_TIMEOUT_MS,
    );
    extract = parseNodeArchiveExtractResult(data);
  } catch (err) {
    await cleanupStaging(to.nodeId, [toStaging]);
    throw rethrowNodeError(err, to.nodeId, "archive_extract");
  }
  await cleanupStaging(to.nodeId, [toStaging]);
  if (extract === null) return malformed(to.nodeId, "archive_extract");
  return { archiveBytes: create.size, extract };
}

/**
 * Stream the staging archive window by window, ONE decoded window at a time,
 * verifying the running sha256 against `archive_create`'s answer before the
 * eof chunk is trusted. `file_read`'s cursor grammar does the loop
 * arithmetic; a source that shrinks under us is a refusal, not a truncation
 * to silently extract.
 */
async function relayWindows(
  fromNodeId: string,
  toNodeId: string,
  fromStaging: string,
  toStaging: string,
  create: { size: number; sha256: string },
): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  let offset = 0;
  let index = 0;
  while (offset < create.size) {
    let read: ReturnType<typeof parseNodeFileReadResult>;
    try {
      const data = await nodeCommand(
        fromNodeId,
        {
          type: "file_read",
          path: fromStaging,
          fromByte: offset,
          maxBytes: MAX_TRANSFER_WINDOW_BYTES,
        },
        READ_TIMEOUT_MS,
      );
      read = parseNodeFileReadResult(data);
    } catch (err) {
      throw rethrowNodeError(err, fromNodeId, "file_read");
    }
    if (read === null) return malformed(fromNodeId, "file_read");
    if (read.bytes_b64 === "") {
      throwApiError({
        code: BackendErrorCodes.NODE_UNREACHABLE,
        message: `the source archive shrank under the relay (${offset} of ${create.size} bytes seen)`,
        doNotLog: true,
      });
    }
    const bytes = Buffer.from(read.bytes_b64, "base64");
    hasher.update(bytes);
    const eof = read.next >= create.size;
    try {
      const data = await nodeCommand(
        toNodeId,
        {
          type: "transfer_write",
          path: toStaging,
          chunkB64: read.bytes_b64,
          chunk: index,
          eof,
        },
        WRITE_CHUNK_TIMEOUT_MS,
      );
      const wrote = parseNodeWriteFileResult(data);
      if (wrote === null) return malformed(toNodeId, "transfer_write");
      if (eof && wrote.received !== create.size) {
        throwApiError({
          code: BackendErrorCodes.NODE_UNREACHABLE,
          message: `destination node received ${wrote.received} of ${create.size} archive bytes`,
          doNotLog: true,
        });
      }
    } catch (err) {
      throw rethrowNodeError(err, toNodeId, "transfer_write");
    }
    if (eof && hasher.digest("hex") !== create.sha256) {
      throwApiError({
        code: BackendErrorCodes.NODE_UNREACHABLE,
        message: "the relayed archive did not match the source's digest; nothing was extracted",
        doNotLog: true,
      });
    }
    offset = read.next;
    index += 1;
  }
}

/**
 * Page one manifest to completion. `tolerateMissingRoot` is the destination's
 * shape of the question: a root that does not exist YET is the ordinary
 * first sync (empty manifest), while an allowlist refusal stays a refusal -
 * folding it in would move a whole tree toward a destination that was never
 * permitted, only to fail at extract.
 */
async function collectManifest(
  endpoint: TransferEndpoint,
  tolerateMissingRoot = false,
): Promise<NodeManifestEntryWire[]> {
  const all: NodeManifestEntryWire[] = [];
  let cursor: string | undefined;
  for (;;) {
    let page: ReturnType<typeof parseNodeTreeManifestPage>;
    try {
      const data = await nodeCommand(
        endpoint.nodeId,
        {
          type: "tree_manifest",
          root: endpoint.path,
          ...(cursor === undefined ? {} : { cursor }),
          maxBytes: MAX_MANIFEST_PAGE_BYTES,
        },
        MANIFEST_TIMEOUT_MS,
      );
      page = parseNodeTreeManifestPage(data);
    } catch (err) {
      if (
        tolerateMissingRoot &&
        err instanceof NodeRpcError &&
        err.code === "failed" &&
        !err.message.includes("allowed directories") &&
        err.message.includes("ENOENT") // the agent's walk surfaces the raw code in its sentence
      ) {
        return [];
      }
      throw rethrowNodeError(err, endpoint.nodeId, "tree_manifest");
    }
    if (page === null) return malformed(endpoint.nodeId, "tree_manifest");
    all.push(...page.entries);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

/** The plane-minted staging name: a unique file under the node's own dataDir (spec §4). */
function stagingPathFor(nodeId: string): string {
  const facts = getLive(nodeId)?.agent;
  if (!facts?.dataDir) {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "That node has no live connection reporting its data directory",
      doNotLog: true,
    });
  }
  return `${facts.dataDir.replace(/\/+$/, "")}/transfers/${randomUUID()}.tar.gz`;
}

/** The `.part` name `chunked-stream.ts` uses beside a final path. */
function partPathOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return `${path.slice(0, cut + 1)}.${path.slice(cut + 1)}.part`;
}

/** Best-effort staging cleanup; a dead node needs no help (its files are inert). */
async function cleanupStaging(nodeId: string, paths: string[]): Promise<void> {
  try {
    await nodeCommand(nodeId, { type: "remove_paths", paths }, CLEANUP_TIMEOUT_MS);
  } catch (err) {
    logger
      .withError(err)
      .warn(`transfer staging cleanup on node ${nodeId} failed (left for the sweep) ${paths.join(", ")}`);
  }
}

/** One signed command, typed at the seam the RPC owns. */
async function nodeCommand(nodeId: string, cmd: NodeCommandBody, timeoutMs: number): Promise<unknown> {
  return await sendCommand(nodeId, cmd, { timeoutMs });
}

/**
 * Map a {@link NodeRpcError} onto the wire family (the files-remote-browse
 * vocabulary): `offline` → NODE_OFFLINE, `unsupported` → NODE_OUTDATED
 * naming the update remedy (spec §5 R12 - the agent's own contract answer is
 * otherwise cryptic), timeout/failed → NODE_UNREACHABLE carrying the RPC's
 * message (an agent refusal sentence IS the operator-actionable fact here,
 * e.g. a guard naming the refused entry).
 */
function rethrowNodeError(err: unknown, nodeId: string, verb: string): never {
  if (!(err instanceof NodeRpcError)) throw err;
  return transferFailed(err, nodeId, verb);
}

function transferFailed(err: NodeRpcError, nodeId: string, verb = "command"): never {
  if (err.code === "offline") {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: `node ${nodeId} disconnected mid-${verb}`,
      doNotLog: true,
    });
  }
  if (err.code === "unsupported") {
    // The code the MCP's describeToolError turns into "update the node"
    // (spec 2026-10-01 §5 R12): an `unsupported` answer is otherwise a
    // sentence about a verb nobody named.
    throwApiError({
      code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
      message: `the agent on node ${nodeId} predates archive transfer; update the node`,
      doNotLog: true,
    });
  }
  if (err.code === "timeout") {
    throwApiError({
      code: BackendErrorCodes.NODE_UNREACHABLE,
      message: `node ${nodeId} timed out during ${verb}`,
      doNotLog: true,
    });
  }
  throwApiError({
    code: BackendErrorCodes.NODE_UNREACHABLE,
    message: `node ${nodeId} refused ${verb}: ${err.message}`,
    doNotLog: true,
  });
}

/** A validator-refused answer: the node is broken, and say so with 500-class honesty. */
function malformed(nodeId: string, verb: string): never {
  throwApiError({
    code: BackendErrorCodes.NODE_UNREACHABLE,
    message: `node ${nodeId} answered ${verb} with a malformed payload`,
    doNotLog: false,
  });
}
