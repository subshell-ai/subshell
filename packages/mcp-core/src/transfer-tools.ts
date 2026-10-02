import { z } from "zod";
import type { ToolDeps } from "./tools.js";

/**
 * The file-transfer tool (spec 2026-10-01 §6): one synchronous
 * `transfer_files` over `POST /api/transfers`, copying or diff-syncing a
 * directory between two AGENT NODES the caller owns. Many small files ride
 * the terminal pane terribly (base64 through a PTY mangles bytes and floods
 * pane logs that have a retention policy), which is why this seam exists at
 * all; the plane relays one streamed archive between the nodes and neither
 * machine needs `tar` or `rsync`.
 *
 * The tool is SYNC like the REST route it rides: it returns when the tree
 * has landed or failed, and the caps (4 GiB uncompressed, window-bounded
 * relay) keep a call inside sane client-timeout territory. v1 never deletes
 * at the destination and cannot resume an interrupted transfer - re-running
 * the call IS the retry (additive extraction makes it safe).
 */

/** What a completed transfer reports (the route's response shape). */
export interface TransferFilesResult {
  /** Echo of the request mode. */
  sync: boolean;
  /** Compressed archive bytes relayed (0 for a no-op sync). */
  archiveBytes: number;
  /** Files extracted at the destination. */
  files: number;
  /** Uncompressed body bytes written at the destination. */
  bytes: number;
  /** Sync only: rows the diff marked changed. */
  changed: number;
}

/** One endpoint as the TOOL names it: a machine by id or display name. */
export interface TransferEndpointArg {
  node: string;
  path: string;
}

/** Minimal `/api/nodes` row view - only what the addressing needs. */
interface NodeAddressRow {
  id: string;
  name: string;
}

/**
 * Resolve one endpoint's machine, accepting an exact node id FIRST and a
 * case-insensitive name otherwise - the same grammar `create_subshell`'s
 * `node` field uses (ids survive renames; a tie is refused, never guessed).
 * Local to this module on purpose: the shared extraction belongs with the
 * merge of the branch that grew it, not as a second edit into the file both
 * carry.
 */
function resolveNodeId(nodes: NodeAddressRow[], want: string): string {
  const byId = nodes.filter((n) => n.id === want);
  const matches =
    byId.length > 0 ? byId : nodes.filter((n) => n.name.toLowerCase() === want.trim().toLowerCase() || n.name === want);
  const [only] = matches;
  if (!only) {
    const available = nodes.map((n) => n.name).join(", ");
    throw new Error(
      `subshell: no node '${want}'${available ? `; available: ${available}` : "; no machines are enrolled"}; call list_nodes`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `subshell: more than one node matches '${want}' (${matches.map((n) => n.id).join(", ")}); pass the node id`,
    );
  }
  return only.id;
}

/**
 * `transfer_files`: copy (or sync) `from.path` on one owned agent node to
 * `to.path` on another. Both nodes must be owned by this pane's account,
 * online, and out of maintenance; the node's operator allowlist gates the
 * directories on each end.
 */
export async function transferFiles(
  deps: ToolDeps,
  args: { from: TransferEndpointArg; to: TransferEndpointArg; sync?: boolean },
): Promise<TransferFilesResult> {
  const nodes = (await deps.api.req<{ nodes: NodeAddressRow[] }>("/api/nodes")).nodes;
  const from = { nodeId: resolveNodeId(nodes, args.from.node), path: args.from.path };
  const to = { nodeId: resolveNodeId(nodes, args.to.node), path: args.to.path };
  return await deps.api.req<TransferFilesResult>("/api/transfers", {
    method: "POST",
    body: { from, to, ...(args.sync !== undefined ? { sync: args.sync } : {}) },
  });
}

// --- tool schema (named constant per the code-style rule) ---

/** One endpoint object: a machine an agent can name and a path on it. */
const EndpointArgSchema = z.object({
  node: z.string().describe("Agent node id or display name from list_nodes; the caller must own it"),
  path: z
    .string()
    .describe("Absolute directory ON that node; the node's operator allowlist gates it (empty list = unrestricted)"),
});

/** `transfer_files`: two endpoints and the optional diff-sync flag. */
export const TransferFilesToolSchema = z.object({
  from: EndpointArgSchema.describe("Source directory tree"),
  to: EndpointArgSchema.describe(
    "Destination directory; extraction is ADDITIVE (matching files are overwritten, nothing is ever deleted)",
  ),
  sync: z
    .boolean()
    .optional()
    .describe(
      "true diffs the two trees on per-file SHA-256 and ships only changed files (re-running converges); false/absent copies the whole source tree",
    ),
});
