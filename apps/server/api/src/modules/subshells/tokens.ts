import type { ApiKeyPermission } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { CreatedApiKey, SubshellKeyMetadata } from "@/modules/auth/apikey-store.js";
import { getApiKeyMetadata, setApiKeyEnabled, setApiKeyExpiry } from "@/modules/auth/apikey-store.js";
import { getAuth } from "@/modules/auth/auth.js";
import { systemKeyPermissions } from "@/modules/auth/system-key-permissions.js";
import { findSystemUserId } from "@/modules/auth/system-user.js";
import { logger } from "@/shared/logger.js";

/** Per-subshell MCP token lifetime. Self-extension resets it; death revokes it. */
const SUBSHELL_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days (plugin min is 1 day)

/** A pane token's grant map, as better-auth stores it. */
export type PaneTokenPermissions = Record<string, string[]>;

/**
 * The grants a pane holds when its MCP wiring is ON: everything the MCP tools
 * drive, and the `subshells` scope the harness hooks ride as well.
 *
 * `prompts` joined the map with the saved-prompt library (spec 2026-09-28); a
 * pane may full-CRUD its OWNER's prompts over MCP. `transfers` joined with
 * node-to-node archive transfer (spec 2026-10-01 §5) and, unlike prompts, gets
 * NO legacy pass in `requirePerm`: pre-feature maps 403 on transfers until the
 * pane restarts and re-mints. Grandfathering old tokens into a file-move grant
 * is exactly the mistake the prompts concession would be to copy.
 */
export function paneTokenPermissions(): PaneTokenPermissions {
  return {
    channels: ["read", "write"],
    subshells: ["read", "write"],
    prompts: ["read", "write"],
    transfers: ["read", "write"],
  };
}

/**
 * The grants a pane holds when the MCP is switched off for it, by its owner's
 * account or by the node it launched on: `report`, and nothing else.
 *
 * That is exactly the four `subshell report` verbs the harness hooks run, so
 * the pane still says when its turn ended, still rings and clears its own
 * waiting bell, still reports its exit code and session id, and still
 * self-extends its token (that door checks ownership, not a scope, though a
 * derived execution key still meets its `subshells:execute` grant, exactly as
 * the MCP child did; and every report verb but `exit` rides the extend in
 * parallel, so a hook-live pane never reaches the TTL wall even with no MCP
 * child to arm the periodic one). What
 * it cannot do is read another pane, send input to one, create or terminate
 * one, post to a channel, touch the prompt library, or move a file: the
 * sibling surface §4 of docs/security.md accounts for is gone from this key
 * rather than merely left without a tool that names it.
 *
 * One dialect caveat: for opencode and pi the CHILD ROSTER reporter
 * is a harness extension that ships inside the MCP registration, not a hook
 * command line, so a switched-off pane of those dialects loads no bridge and
 * reports no roster. The door stays open for it (a report-only key passes
 * `requireReportPerm`); nothing walks through. Dialects whose roster rides the
 * hook reporter keep reporting.
 *
 * A fresh object per call, like the full map: the auth plugin treats the map
 * as mutable.
 */
export function reportingTokenPermissions(): PaneTokenPermissions {
  return { report: ["write"] };
}

/**
 * Mints the per-subshell MCP API key: a better-auth api-key bound to the
 * subshell via `metadata.subshellId`, its id recorded on the subshell row for
 * deterministic revoke/extend. Returns the plaintext key ONCE (injected into
 * the subshell's env; never stored server-side in the clear — the plugin
 * hashes it).
 *
 * `permissions` is the launch's MCP decision in credential form, and the caller
 * that read the two switches passes it: a pane with the wiring switched off
 * gets {@link reportingTokenPermissions} and no registration, so the two halves
 * of one decision cannot be taken in two places and drift. The default is the
 * full map, which is what every caller that predates the switch means.
 *
 * @param subshellId - the subshell this token authenticates
 * @param userId - owning user (the api-key reference)
 * @param ceiling - inherited system-key grants, or null for an ordinary pane
 * @param permissions - the grant map to mint; the full MCP set by default
 */
export async function issueSubshellToken(
  subshellId: string,
  userId: string,
  ceiling: ApiKeyPermission[] | null = null,
  permissions: PaneTokenPermissions = paneTokenPermissions(),
): Promise<string> {
  const metadata: SubshellKeyMetadata = {
    kind: "subshell",
    subshellId,
    ...(ceiling === null ? {} : { permissionVersion: 1, systemPermissions: ceiling }),
  };
  const created = (await getAuth().api.createApiKey({
    body: {
      name: `sess:${subshellId}`,
      userId,
      expiresIn: SUBSHELL_TOKEN_TTL_SECONDS,
      metadata,
      permissions,
    },
  })) as unknown as CreatedApiKey;
  await new SubshellsRepository(db).update(subshellId, { apiKeyId: created.id });
  return created.key;
}

/**
 * Revokes a subshell's token (disable, not delete — the audit row survives).
 * No-op when the subshell never got a token or it is already revoked.
 *
 * @param subshellId - the subshell whose token to revoke
 */
export async function revokeSubshellToken(subshellId: string): Promise<void> {
  const row = await new SubshellsRepository(db).findById(subshellId);
  if (!row?.apiKeyId) return;
  setApiKeyEnabled(row.apiKeyId, false);
  logger.info(`subshell token revoked: ${subshellId}`);
}

/**
 * Pushes a subshell token's expiry out to a fresh TTL (self-extension for long
 * tasks). Returns false when the subshell has no token. A revoked token is
 * re-armed here ONLY if the caller still controls a live subshell row — the
 * route enforces that this is called for the caller's OWN subshell.
 *
 * @param subshellId - the subshell whose token to extend
 */
export async function extendSubshellToken(subshellId: string): Promise<boolean> {
  const row = await new SubshellsRepository(db).findById(subshellId);
  if (!row?.apiKeyId) return false;
  setApiKeyExpiry(row.apiKeyId, new Date(Date.now() + SUBSHELL_TOKEN_TTL_SECONDS * 1000).toISOString());
  return true;
}

/** The TTL the service stamps on new/extended tokens (for the route's response). */
export const subshellTokenTtlSeconds = (): number => SUBSHELL_TOKEN_TTL_SECONDS;

/** Read the previous ceiling before rotation, including disabled tokens. A lost system token fails closed. */
export async function subshellSystemPermissions(
  subshellId: string,
  userId: string,
): Promise<ApiKeyPermission[] | null> {
  const row = await new SubshellsRepository(db).findById(subshellId);
  if (row?.apiKeyId) {
    const metadata = getApiKeyMetadata(row.apiKeyId);
    if (metadata !== undefined) return systemKeyPermissions(metadata);
  }
  return userId === findSystemUserId() ? [] : null;
}
