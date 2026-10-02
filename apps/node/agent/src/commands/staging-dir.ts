import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The node's transfer staging directory: `<dataDir>/transfers/`.
 *
 * Every staging-touching gate (`archive_create`'s `stagingPath`,
 * `transfer_write`'s permitted roots, `file_read`'s admitted subtree,
 * `archive_extract`'s `archivePath`) names THIS directory, and a plane never
 * picks the name (spec 2026-10-01 §4). It has to EXIST before those gates
 * mean anything: `pathAllowed` realpath's its roots and DROPS one it cannot
 * resolve, so a fresh node whose first transfer has not landed yet would
 * refuse its own staging write against a root that isn't there. This module
 * owns the one-time creation.
 */
export function transfersDir(dataDir: string): string {
  return join(dataDir, "transfers");
}

/**
 * Create `<dataDir>/transfers/` (idempotent) and return its path, chmod'd to
 * 0700 (mkdir's mode option is umask-masked, so it is re-tightened after a
 * fresh create - the `identity.ts` dataDir pattern). Called by the two
 * FIRST-WRITER commands (`archive_create`, `transfer_write`) at entry and by
 * the daemon at boot. A dataDir that cannot host the directory throws; the
 * caller turns it into a refusal rather than letting the gates silently widen
 * over a missing root.
 */
export function ensureTransfersDir(dataDir: string): string {
  const dir = transfersDir(dataDir);
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true }); // recursive: a fresh node's dataDir subtree may not be there yet
  if (!existed) chmodSync(dir, 0o700);
  return dir;
}
