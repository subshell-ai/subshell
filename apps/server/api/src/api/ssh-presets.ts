import { SSH_MAX_SELECTED_FINGERPRINTS } from "@internal/subshell-protocol";
import { type Static, t } from "elysia";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { SshExpectedDestinationField, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { db } from "@/db/index.js";
import { SshPresetsRepository } from "@/db/repositories/ssh-presets.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";
import { nodeCanLaunchOn } from "@/lib/node-access.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import { sshCanonicalDestination } from "@/services/ssh-destination.js";
import { sshResolveDestination } from "@/services/ssh-launch.service.js";

const SshPresetFields = {
  name: t.String({ minLength: 1, maxLength: 120, description: "Preset name, unique per owner" }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 500, description: "Optional preset description" }))),
  nodeId: t.String({ minLength: 1, maxLength: 200, description: "Connecting node id" }),
  destination: t.String({
    minLength: 1,
    maxLength: 253,
    description: "SSH destination; saved as the canonical resolved address",
  }),
  resolutionAlias: t.Optional(
    t.Nullable(
      t.String({
        minLength: 1,
        maxLength: 253,
        description:
          "Original SSH token whose alias-scoped routing and key settings are reused with the saved canonical destination constraint",
      }),
    ),
  ),
  alias: t.Optional(
    t.Nullable(
      t.String({
        minLength: 1,
        maxLength: 253,
        description: "Display alias, never used to resolve a saved destination",
      }),
    ),
  ),
  authentication: t.Union(
    [t.Literal("connecting"), t.Literal("remote"), t.Literal("local-key"), t.Literal("password")],
    { description: "How a connection authenticates; no credentials are stored" },
  ),
  keyHome: t.Optional(
    t.Nullable(
      t.String({ minLength: 1, maxLength: 200, description: "Node providing selected keys for remote authentication" }),
    ),
  ),
  fingerprints: t.Optional(
    t.Nullable(
      t.Array(t.String({ pattern: "^SHA256:[A-Za-z0-9_-]{43}$", description: "Selected public key fingerprint" }), {
        maxItems: SSH_MAX_SELECTED_FINGERPRINTS,
        description: "Public key selection, used only for remote authentication",
      }),
    ),
  ),
};
export const CreateSshPresetSchema = t.Object(
  {
    kind: t.Literal("ssh", { description: "SSH preset discriminator" }),
    ...SshPresetFields,
    expectedDestination: SshExpectedDestinationField,
  },
  { additionalProperties: false },
);
export const UpdateSshPresetSchema = t.Object(
  { ...SshPresetFields, expectedDestination: SshExpectedDestinationField },
  { additionalProperties: false },
);
export const SshPresetSchema = t.Object({
  ...SshPresetFields,
  kind: t.Literal("ssh", { description: "SSH preset discriminator" }),
  id: t.String({ description: "Preset id" }),
  userId: t.String({ description: "Owning user id" }),
  nodeId: t.Nullable(t.String({ description: "Connecting node id; null after its deletion" })),
  description: t.Nullable(t.String({ description: "Optional preset description" })),
  alias: t.Nullable(t.String({ description: "Display-only destination alias" })),
  resolutionAlias: t.Nullable(
    t.String({ description: "Original SSH resolution token, guarded by the canonical destination" }),
  ),
  keyHome: t.Nullable(t.String({ description: "Remote key node id; null when unset or deleted" })),
  fingerprints: t.Array(t.String({ description: "Selected public key fingerprint" }), {
    description: "Remote key selection, empty for other authentication modes",
  }),
  createdAt: t.String({ description: "Creation timestamp" }),
  updatedAt: t.String({ description: "Last update timestamp" }),
});
export const SSH_PRESET_KEYS = new Set([...Object.keys(SshPresetFields), "expectedDestination"]);
export function sshPresetView(row: SshPresetTable) {
  return {
    ...row,
    kind: "ssh" as const,
    fingerprints: row.fingerprints === null ? [] : (JSON.parse(row.fingerprints) as string[]),
  };
}
export class SshPresetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export async function saveSshPreset(
  userId: string,
  body: Static<typeof UpdateSshPresetSchema>,
  existing?: SshPresetTable,
) {
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
  let destination = body.destination;
  let alias = body.alias ?? null;
  const unchangedDestination = existing?.nodeId === body.nodeId && existing.destination === body.destination;
  const resolutionAlias =
    body.resolutionAlias ?? (unchangedDestination ? existing.resolutionAlias : null) ?? body.destination;
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
      body.expectedDestination ?? (unchangedDestination ? existing.destination : undefined),
    );
    if (!resolved.ok) return throwCodedRefusal(resolved.refusal);
    if (!resolved.value.accepted) return { refusal: resolved.value };
    destination = sshCanonicalDestination(resolved.value.snapshot);
    alias = body.alias ?? resolved.value.snapshot.alias;
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
    userId,
    name,
    description: body.description ?? null,
    nodeId: body.nodeId,
    destination,
    resolutionAlias,
    alias,
    authentication: body.authentication,
    keyHome: body.authentication === "remote" ? (body.keyHome ?? null) : null,
    fingerprints:
      body.authentication === "remote" && body.fingerprints != null ? JSON.stringify(body.fingerprints) : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    const repo = new SshPresetsRepository(db);
    return sshPresetView(existing ? await repo.update(existing.id, row) : await repo.create(row));
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE"))
      throw new SshPresetError("duplicate", "You already have an SSH preset with that name", 409);
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
