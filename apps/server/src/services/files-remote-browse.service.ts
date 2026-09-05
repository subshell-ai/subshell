import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { dirAllowed, parseNodeFsLsResult } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { loadNodeAccess, nodeCanManageFor } from "@/lib/node-access.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/**
 * The REMOTE half of the folder picker (`GET /api/files/explore?node=<id>`,
 * spec 2026-08-31 §6 plane + the v3 `fs_ls` command): one signed round-trip
 * to the node's agent, answered in the LOCAL explore shape so the picker
 * component never learns which transport served it.
 *
 * Error bodies ride the same wire codes the local `FilesError` throws produce
 * through the global handler (404 `NOT_FOUND_ERROR`, 403 `ACCESS_DENIED`,
 * 400 `BAD_REQUEST`), plus the nodes plane's 409 family (`NODE_OUTDATED` /
 * `NODE_OFFLINE` / `NODE_UNREACHABLE`) — so every failure a remote browse can
 * answer is one the frontend already knows how to speak.
 */

/** The remote browse's one round-trip deadline — an interactive picker read,
 *  the stat_dir class of command (spec §6.3 table order). */
const FS_LS_TIMEOUT_MS = 5_000;

/**
 * The agent-side refusal prefixes of `fs-ls.ts` (apps/client), as wrapped by
 * `resolveResult` into `node "<id>" reported: <PREFIX>: <path>`. The prefixes
 * are OUR protocol — pinned by the agent's own suite — and text-coupling the
 * mapping is the established idiom here (see remote-launcher's ALREADY_GONE_RE
 * / BINARY_MISSING_RE).
 */
const AGENT_FS_ERROR_RE = /reported: (ENOENT|EACCES|EINVAL):/;

/**
 * Map one {@link NodeRpcError} from the browse round-trip onto the wire: the
 * 409 family with structured codes (the uploads-relay and recheck mappings'
 * vocabulary), the agent's own `ok:false` prefixes onto the same 404/403/400
 * the local path throws for the same conditions. Agent refusal text beyond
 * those pinned prefixes is never echoed to the browser.
 */
function rethrowRemoteBrowseError(err: NodeRpcError): never {
  // If-chain (not a switch): biome's fall-through rule cannot see that
  // `throwApiError` — typed `never` — ends every arm.
  if (err.code === "offline") {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "That node has no live agent connection",
      doNotLog: true,
    });
  }
  if (err.code === "timeout") {
    throwApiError({
      code: BackendErrorCodes.NODE_UNREACHABLE,
      message: "The node did not answer the folder listing in time",
      doNotLog: true,
    });
  }
  if (err.code === "unsupported") {
    // The agent itself says it does not know the command. Unreachable in
    // theory — the protocol is matched exactly at `ready`, so a connected
    // agent speaks this one — but it is the agent's own answer and the honest
    // thing to relay: it cannot do the thing either way.
    throwApiError({
      code: BackendErrorCodes.NODE_OUTDATED,
      message: "The subshell app on this node is too old to browse folders there — update it.",
      doNotLog: true,
    });
  }
  // Here: the agent answered `ok:false`. The pinned prefixes ride the local
  // route's status classes; anything else the browser cannot act on gets
  // the 409 family with a generic body (agent text is never echoed).
  const prefix = AGENT_FS_ERROR_RE.exec(err.message)?.[1];
  if (prefix === "ENOENT") {
    throwApiError({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Path does not exist", doNotLog: true });
  }
  if (prefix === "EACCES") {
    throwApiError({ code: BackendErrorCodes.ACCESS_DENIED, message: "Directory is not readable", doNotLog: true });
  }
  if (prefix === "EINVAL") {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: "Browsing a node needs an absolute path (no ~ expansion)",
      doNotLog: true,
    });
  }
  throwApiError({
    code: BackendErrorCodes.NODE_UNREACHABLE,
    message: "The node could not list this directory",
    doNotLog: true,
  });
}

/** The explore response's directory-entry shape (local and remote agree). */
export interface RemoteExploreResult {
  /** Resolved directory on the node (the agent's realpath) */
  path: string;
  /** Parent directory, null at the filesystem root */
  parent: string | null;
  /** Direct-child directories only — the local shape minus files */
  entries: { name: string; path: string; kind: "dir" }[];
  /** Always empty remotely — see the module docstring (dead-click rule) */
  recent: { path: string; label: string | null }[];
  /** Always empty remotely (favorites are not node-scoped on disk) */
  favorites: { path: string; label: string | null }[];
}

/**
 * One-level browse of ANOTHER machine: visibility (404, never 403), the
 * `fs_ls` feature gate, one signed round-trip, and error mapping.
 * Confinement notes: `SUBSHELL_FS_ROOT` deliberately does NOT apply here (it
 * belongs to this host and means nothing on the node — the node's boundary is
 * its agent user's filesystem permissions, the same posture as `stat_dir`),
 * and Recent/Favorites ship EMPTY (they are control-plane concepts; the
 * form's per-node pre-fill rides `/recent?node=` instead).
 *
 * @param userId - the cookie-authenticated browser user (access-check subject)
 * @param nodeId - the node to browse (never `local`; the route checked)
 * @param rawPath - the caller's `path` param; absent/`~` ⇒ the AGENT's home
 * @throws ApiError 404 invisible/absent node; 409 NODE_OUTDATED (the agent itself refuses
 *         fs_ls), NODE_OFFLINE, NODE_UNREACHABLE; 404/403/400 mirroring the
 *         local route for the agent's ENOENT/EACCES/EINVAL answers; 500 for a
 *         malformed listing (protocol violation)
 */
export async function exploreNodeDirectory(
  userId: string,
  nodeId: string,
  rawPath: string | undefined,
): Promise<RemoteExploreResult> {
  const { row, access } = await loadNodeAccess(
    { nodes: new NodesRepository(db), shares: new NodeSharesRepository(db), userMeta: new UserMetaRepository(db) },
    userId,
    nodeId,
  );
  // Absent and invisible collapse to one 404, exactly like /recent's scoping —
  // node ids cannot be probed through the folder picker.
  if (access === "none" || !row) {
    throwApiError({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found", doNotLog: true });
  }
  // The picker spells "home" `~`; the server CANNOT expand that against a
  // filesystem it cannot see, and the agent does no tilde work by contract.
  // Empty path = the agent's home — the node user's home is the honest
  // default when the user picked this machine to launch on.
  const raw = rawPath?.trim() ?? "";
  const path = raw === "~" ? "" : raw;

  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "fs_ls", path }, FS_LS_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof NodeRpcError) rethrowRemoteBrowseError(err); // never returns
    throw err;
  }
  const listing = parseNodeFsLsResult(data);
  if (!listing) {
    // ok:true with a payload we cannot read is a protocol violation — the
    // caller cannot fix it, so it surfaces as a logged 5xx, not a 4xx.
    throwApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "The node returned a malformed directory listing",
    });
  }
  // UX scoping for the launch picker (spec 2026-09-05): a caller who cannot
  // MANAGE this node sees only entries they could actually launch in — an
  // entry whose only outcome is a refusal is friction, not information. The
  // node's owner browses unfiltered, because they are choosing what to permit
  // and a scoped view would make the second rule unaddable.
  //
  // NOT the security boundary. That is the launch gate, applied here
  // (`assertDirAllowed`) and independently on the node, neither of which cares
  // who is browsing.
  const isAdmin = (await new UserMetaRepository(db).getRole(userId)) === "admin";
  const dirs = nodeCanManageFor(row.kind, access, isAdmin)
    ? []
    : await getRequestlessContext().repos.nodeAllowedDirs.listForNode(nodeId);
  const entries = dirs.length === 0 ? listing.entries : listing.entries.filter((e) => dirAllowed(e.path, dirs));
  return {
    path: listing.path,
    parent: listing.parent,
    entries,
    recent: [],
    favorites: [],
  };
}
