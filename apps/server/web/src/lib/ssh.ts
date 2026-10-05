import { ApiError, errMessage } from "@internal/node-admin";
import {
  isSshErrorCode,
  SSH_ERROR_DESCRIPTIONS,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
} from "@internal/subshell-protocol";

/**
 * The SPA-side mirror of the frozen SSH REST shapes
 * (`apps/server/api/src/services/ssh/ssh-api-types.ts` - "they are law after
 * Gate A"). The web app consumes `/api/ssh` through `apiFetch`, so it needs
 * the field names, not the backend module: this mirrors the contract exactly
 * the way `packages/mcp-core` redeclares it, and every addition of a field
 * here is a signal the mirror drifted and BOTH sides need a look. The wire
 * types that live in `@internal/subshell-protocol` (the snapshot, the named
 * refusal codes) are imported, never restated - that package is the single
 * shared definition.
 */

/** Which side of the human/agent boundary holds or initiated something (mirrors the backend's `SshActorSide`). */
export type SshActorSide = "human" | "agent";

/** `GET /api/ssh/discovery` response: alias NAMES on a node, never config contents. */
export interface SshDiscoveryView {
  /** Alias names, sorted, wildcard-only entries excluded */
  aliases: string[];
  /** An include cycle was detected during the bounded parse */
  includeCycle: boolean;
  /** The alias cap was hit; more exist */
  truncated: boolean;
}

/** `POST /api/ssh/connections/resolve` response; a named refusal is a 200, not a transport failure. */
export type SshResolveView =
  | {
      accepted: true;
      snapshot: SshConnectionSnapshotWire;
      /** The connecting OS account name when the node could report it */
      connectingAccount?: string;
    }
  | {
      accepted: false;
      /** Named limitation. */
      code: SshErrorCode;
      /** Config keywords that blocked, when the code names several. */
      settings: string[];
    };

/** `POST /api/ssh/connections/test` response. `passed:false` is 200 with a named code. */
export type SshTestConnectionView = { passed: true } | { passed: false; code: SshErrorCode };

/** `POST /api/ssh/connections` body. */
export interface SshCreateConnectionRequest {
  nodeId: string;
  displayName: string;
  snapshot: SshConnectionSnapshotWire;
  remoteDir?: string | null;
}

/** `PATCH /api/ssh/connections/:id` body; omitted fields stay as stored. */
export interface SshUpdateConnectionRequest {
  displayName?: string;
  remoteDir?: string | null;
  /** A replacement snapshot creates a NEW revision and invalidates grants. */
  snapshot?: SshConnectionSnapshotWire;
}

/** A stored connection, as every connections read answers it. */
export interface SshConnectionView {
  id: string;
  /** Connecting node id (the route line ends "via <node name>") */
  nodeId: string;
  displayName: string;
  snapshot: SshConnectionSnapshotWire;
  remoteDir: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/ssh/connections` response. */
export interface SshConnectionListView {
  connections: SshConnectionView[];
}

/** A grant row, as the grants reads answer it. */
export interface SshGrantView {
  id: string;
  connectionId: string;
  /** Pinned revision: editing the connection invalidates grants. */
  connectionRevision: number;
  subshellId: string;
  apiKeyId: string;
  grantedByUserId: string;
  grantedAt: string;
  revokedAt: string | null;
  /** Convenience mirror of `revokedAt === null`. */
  active: boolean;
}

/** `GET /api/ssh/connections/:id/grants` response. */
export interface SshGrantListView {
  grants: SshGrantView[];
}

/** `POST /api/ssh/terminals` response: the managed pane plus its control facts. */
export interface SshTerminalView {
  subshellId: string;
  connectionId: string;
  connectionRevision: number;
  initiatedBy: SshActorSide;
  controlOwner: SshActorSide;
  controlGeneration: number;
  logGeneration: number;
  createdAt: string;
}

/** `POST /api/subshells/:id/ssh-control` response. */
export interface SshControlView {
  subshellId: string;
  controlOwner: SshActorSide;
  controlGeneration: number;
}

/**
 * The destination as a reviewer reads it: `deploy@app-02`, plus `:2222` only
 * when the port is not the default. This is a DISPLAY string rendered from a
 * snapshot's fields - routing never re-reads it, and no input box ever takes
 * one back (spec §2: only connection IDs are accepted as references).
 */
export function sshDestinationLabel(snapshot: SshConnectionSnapshotWire): string {
  const userAt = snapshot.user ? `${snapshot.user}@` : "";
  const port = snapshot.port === 22 ? "" : `:${snapshot.port}`;
  return `${userAt}${snapshot.host}${port}`;
}

/**
 * The route identity line spec §3 demands on every surface that names a
 * connection: "Staging · deploy@app-02 · via Laptop". The node label is the
 * caller's (resolved from the nodes list); a never-answered read passes null
 * and the route says "via an unknown node" rather than going quiet about the
 * machine the work runs through.
 */
export function sshRouteLine(conn: SshConnectionView, nodeLabel: string | null): string {
  return `${conn.displayName} · ${sshDestinationLabel(conn.snapshot)} · via ${nodeLabel ?? "an unknown node"}`;
}

/**
 * Human copy for a failed SSH request, by EQUALITY on the named code the
 * server carries (the ssh-api-types convention: refusals name themselves,
 * nobody parses a sentence). A thrown error whose `code` is a frozen
 * {@link SshErrorCode} answers with that code's shipped sentence; anything
 * else (a transport failure, an unnamed 500) falls back to the error's own
 * message, then to the caller's fallback.
 */
export function sshErrorText(err: unknown, fallback = "The SSH request failed."): string {
  if (err instanceof ApiError && isSshErrorCode(err.code)) return SSH_ERROR_DESCRIPTIONS[err.code as SshErrorCode];
  return errMessage(err, fallback);
}
