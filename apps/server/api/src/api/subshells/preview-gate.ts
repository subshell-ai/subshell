import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import type { GuardActor } from "@/modules/auth/actor.js";
import { getHeld, isNodeOffline } from "@/modules/nodes/node-registry.js";
import {
  getAnyPreviewEnabled,
  getVirtualDisplayEnabled,
  getWebPreviewsEnabled,
} from "@/modules/nodes/preview-enabled.js";
import { type Access, accessAtLeast, loadSubshellAccess } from "@/modules/subshells/access.js";
import { accountDisabled } from "@/modules/users/account-status.js";
import { HttpError } from "@/shared/errors.js";

/**
 * The shared door for the three preview routes. It mirrors the subshell
 * service's private gate exactly (same 404 for absent-or-invisible, same 403
 * wording for insufficient) because a bearer pane key resolves as its owner
 * with shares off, and the preview routes must not widen or narrow that.
 */

const repos = {
  subshells: new SubshellsRepository(db),
  shares: new SubshellSharesRepository(db),
};

/** The row plus the resolved access, or the HTTP refusal a stranger deserves. */
export async function gatePreview(
  viewerId: string,
  subshellId: string,
  min: Exclude<Access, "none">,
  actor: GuardActor,
): Promise<{ row: SubshellTable; access: Access }> {
  const { row, access } = await loadSubshellAccess(repos, viewerId, subshellId, {
    allowShares: actor !== "subshell-key",
  });
  if (!row || access === "none") throw new HttpError(404, "Subshell not found");
  if (!accessAtLeast(access, min)) {
    throw new HttpError(403, "You don't have permission to do that with this subshell");
  }
  return { row, access };
}

/**
 * What the NODE can do about preview, independent of any one pane: the
 * switch, the held gates, and the link. `reason` is a stable word the SPA
 * maps to a tooltip; the closed set is `preview-disabled`, `node-held`,
 * `node-too-old`, `node-offline`, plus the per-failure words the info route
 * adds when the live call itself refuses.
 */
export interface PreviewNodeState {
  nodeEnabled: boolean;
  reason?: string;
}

/** The node-side truth for one machine: switch off, held, gone, or healthy. */
export async function previewNodeState(
  nodeId: string,
  feature: "web-previews" | "display" | "any" = "web-previews",
): Promise<PreviewNodeState> {
  if (
    !(await (feature === "display"
      ? getVirtualDisplayEnabled
      : feature === "any"
        ? getAnyPreviewEnabled
        : getWebPreviewsEnabled)(nodeId))
  ) {
    return { nodeEnabled: false, reason: "preview-disabled" };
  }
  const held = getHeld(nodeId);
  if (held) {
    // `below-floor` is the version gate; every other hold (protocol
    // mismatch, encryption-required) is a handshake fact, not an age fact.
    return { nodeEnabled: false, reason: held.reason === "below-floor" ? "node-too-old" : "node-held" };
  }
  if (isNodeOffline(nodeId)) {
    return { nodeEnabled: false, reason: "node-offline" };
  }
  return { nodeEnabled: true };
}

/** Recheck after node RPCs so stale route authorization cannot mint fresh access. */
export async function recheckPreviewOpen(
  viewerId: string,
  paneId: string,
  nodeId: string,
  min: "view" | "edit",
  actor: GuardActor,
  feature: "web-previews" | "display" | "any" = "web-previews",
): Promise<Access> {
  if (await accountDisabled(db, viewerId)) throw new HttpError(401, "Your account is no longer available.");
  const { row, access } = await gatePreview(viewerId, paneId, min, actor);
  if (row.nodeId !== nodeId || row.status !== "running" || row.alive !== 1) {
    throw new HttpError(409, "This subshell is no longer running. Open Web previews & screens after restarting it.");
  }
  if (!(await previewNodeState(nodeId, feature)).nodeEnabled) {
    throw new HttpError(409, "Web previews & screens is no longer available on this node.");
  }
  return access;
}
