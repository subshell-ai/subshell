import type { SshForwardWire } from "@internal/subshell-protocol";
import {
  SSH_FINGERPRINT_PATTERN,
  SSH_MAX_FORWARD_ROWS,
  SSH_MAX_SELECTED_FINGERPRINTS,
} from "@internal/subshell-protocol";
import { t } from "elysia";
import { SshExpectedDestinationField, SshForwardRowInputSchema } from "@/api/ssh/ssh-views.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";

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
          "Original SSH token whose alias-scoped routing and key settings are reused with the saved canonical destination constraint; unlike alias, a null here never clears the stored token, resolution falls back to the stored token when the destination is unchanged and to the destination otherwise",
      }),
    ),
  ),
  alias: t.Optional(
    t.Nullable(
      t.String({
        minLength: 1,
        maxLength: 253,
        description:
          "Display alias, never used to resolve a saved destination; omitted on update keeps the stored one, null or whitespace-only clears it",
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
      t.Array(t.String({ pattern: SSH_FINGERPRINT_PATTERN, description: "Selected public key fingerprint" }), {
        maxItems: SSH_MAX_SELECTED_FINGERPRINTS,
        description: "Public key selection, used only for remote authentication",
      }),
    ),
  ),
  forwards: t.Optional(
    t.Nullable(
      t.Array(SshForwardRowInputSchema, {
        maxItems: SSH_MAX_FORWARD_ROWS,
        description:
          "Port forwards this preset carries to every launch; validated by the protocol grammar at save, and a non-loopback bind is still refused at launch until the connecting machine allows it. Omitted on update keeps the stored list, null clears it",
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
  forwards: t.Array(SshForwardRowInputSchema, {
    description: "Declared port forwards, empty when the preset stores none",
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
    forwards: row.forwards === null ? [] : (JSON.parse(row.forwards) as SshForwardWire[]),
  };
}
