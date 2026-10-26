import { parseSshForwardRows, SSH_FORWARD_LIST_REFUSAL } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SshPresetsRepository } from "@/db/repositories/ssh-presets.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";
import { nodeCanLaunchOn } from "@/modules/nodes/access.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { duplicatePresetName } from "@/modules/presets/name-error.js";
import { serverSubshellsEnabled } from "@/modules/server/server-as-node.js";
import { sshPresetView } from "@/modules/ssh/preset-view.js";
import { throwCodedRefusal } from "@/modules/ssh/refusal.js";
import { sshCanonicalDestination } from "@/modules/ssh/ssh-destination.js";
import { sshResolveDestination } from "@/modules/ssh/ssh-launch.service.js";
import type { SshPresetInput } from "./preset-input.js";

/** A refusal of an SSH preset write; `.status` is what the error handler maps to HTTP. */
export class SshPresetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Create or update an SSH preset. The saved destination is always the CANONICAL
 * address, so a create (or any change to node/destination/resolution token)
 * re-resolves on the connecting node and refuses with the resolve outcome
 * rather than writing an unverified destination; an unchanged destination is
 * trusted and never re-resolved. Optional fields follow the PUT convention:
 * omitted keeps what is stored, explicit null clears. Returns the view, or
 * `{ refusal }` when the human's confirmation gate must answer first.
 */
export async function saveSshPreset(userId: string, body: SshPresetInput, existing?: SshPresetTable) {
  const name = body.name.trim();
  if (!name) throw new SshPresetError("bad_request", "Enter a preset name.");
  if (/\p{Cc}/u.test(body.name))
    throw new SshPresetError("bad_request", "Remove control characters from the preset name.");
  if (body.authentication !== "remote" && (body.keyHome != null || (body.fingerprints?.length ?? 0) > 0)) {
    throw new SshPresetError("bad_request", "Only remote key authentication can store a key node or fingerprints");
  }
  if (body.authentication === "remote") {
    if (!body.fingerprints?.length)
      throw new SshPresetError("bad_request", "Select at least one SSH key from the remote node");
    if (!body.keyHome || body.keyHome === body.nodeId)
      throw new SshPresetError("bad_request", "Choose a different node to provide the SSH key");
    await validateNodeAccess(userId, body.keyHome);
  }
  // Declared port forwards (spec 2026-10-15 §7): saved through the protocol's
  // own parser, so no row the launch renderer would refuse can ride a stored
  // preset. Whether a WIDE bind is allowed is a connect-time decision, not a
  // save-time one: a preset stores a wish, and the launch route checks the
  // connecting machine's flag every time it is honored.
  let forwardsJson: string | null = null;
  if (body.forwards !== undefined && body.forwards !== null) {
    const parsed = parseSshForwardRows(body.forwards);
    if (parsed === null) throw new SshPresetError("bad_request", SSH_FORWARD_LIST_REFUSAL);
    if (parsed.length > 0) forwardsJson = JSON.stringify(parsed);
  }
  let destination = body.destination;
  // PUT omits a field it is not deciding about, so an absent alias keeps the
  // stored one (null clears it), the same rule the agent PUT body follows.
  // An alias trimmed away to nothing says the same thing as null: no alias.
  let alias = existing?.alias ?? null;
  if (body.alias !== undefined) alias = body.alias === null ? null : body.alias.trim() || null;
  // TWO different "unchanged" facts. The stored token must keep resolving to
  // the stored ADDRESS whenever the destination text is untouched, even on a
  // machine switch, which then re-resolves on the new node under the same
  // expectedDestination guard. Skipping the resolve entirely (the condition
  // below) additionally needs the node to be the same one.
  const destinationTextUnchanged = !!existing && existing.destination === body.destination;
  const resolutionAlias =
    body.resolutionAlias ??
    (destinationTextUnchanged ? (existing.resolutionAlias ?? body.destination) : body.destination);
  if (
    !existing ||
    existing.nodeId !== body.nodeId ||
    existing.destination !== body.destination ||
    existing.resolutionAlias !== resolutionAlias
  ) {
    const resolved = await sshResolveDestination(
      userId,
      body.nodeId,
      resolutionAlias,
      body.expectedDestination ?? (destinationTextUnchanged ? existing.destination : undefined),
    );
    if (!resolved.ok) return throwCodedRefusal(resolved.refusal);
    if (!resolved.value.accepted) return { refusal: resolved.value };
    destination = sshCanonicalDestination(resolved.value.snapshot);
    // A create has nothing stored, so the resolution's own alias is the only answer.
    if (body.alias === undefined && !existing) alias = resolved.value.snapshot.alias;
  } else {
    await validateNodeAccess(userId, body.nodeId);
  }
  // An alias may expand beyond the launch field's limit. Refuse before a
  // write so the saved row can still round-trip and launch through that field.
  if (destination.length > 253)
    throw new SshPresetError(
      "bad_request",
      "The resolved SSH destination is too long. Use a shorter host or user name so the full address stays within 253 characters.",
    );
  const now = new Date().toISOString();
  const row = {
    id: existing?.id ?? crypto.randomUUID(),
    userId: existing?.userId ?? userId,
    name,
    description: body.description !== undefined ? body.description : (existing?.description ?? null),
    nodeId: body.nodeId,
    destination,
    resolutionAlias,
    alias,
    authentication: body.authentication,
    keyHome: body.authentication === "remote" ? (body.keyHome ?? null) : null,
    fingerprints:
      body.authentication === "remote" && body.fingerprints != null ? JSON.stringify(body.fingerprints) : null,
    // PUT convention, same as `description`: omitted keeps what is stored,
    // null (or an emptied list) clears it.
    forwards: body.forwards === undefined ? (existing?.forwards ?? null) : forwardsJson,
    // The enable switch (0062): a save composes the whole row, so keep what
    // is stored, and a fresh preset starts offered, matching the DB default.
    enabled: existing?.enabled ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    const repo = new SshPresetsRepository(db);
    return sshPresetView(existing ? await repo.update(existing.id, row) : await repo.create(row));
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE"))
      duplicatePresetName("You already have an SSH preset with that name");
    throw err;
  }
}

/** Saving a hint needs launch permission; transient readiness belongs to launch. */
async function validateNodeAccess(userId: string, nodeId: string) {
  const gate = await loadNodeGate(userId, nodeId);
  if (!gate) throw new SshPresetError("not_found", "Node not found", 404);
  if (!nodeCanLaunchOn(gate.row.kind, gate.access, gate.granted, false, await serverSubshellsEnabled(db))) {
    throw new SshPresetError("forbidden", "You need permission to launch subshells on this node", 403);
  }
}
