import { type SshSessionDraft, sshDestination, sshSessionDraft } from "@/components/connect/ssh-session-draft";
import type { SshPreset, SshPresetPayload } from "@/types/preset";

export const SSH_AUTHENTICATION_LABELS = {
  connecting: "Connecting node’s keys",
  remote: "Another node’s keys",
  "local-key": "Key from my machine",
  password: "Password",
} as const;

/** Start from a clean draft so no previous key selection or save intent survives. */
export function sshDraftFromPreset(preset: SshPreset): SshSessionDraft {
  return {
    ...sshSessionDraft({ node: preset.nodeId ?? "", destination: preset.destination }),
    presetApplied: true,
    expectedDestination: preset.destination,
    resolutionAlias: preset.resolutionAlias ?? undefined,
    authentication: preset.authentication,
    keyHome: preset.authentication === "remote" ? (preset.keyHome ?? "") : "",
    selections:
      preset.authentication === "remote" && preset.keyHome ? { [preset.keyHome]: [...preset.fingerprints] } : {},
  };
}

/** Explicit projection prevents credentials and form-only state reaching persistence. */
export function sshPresetPayload(draft: SshSessionDraft, name: string, description = ""): SshPresetPayload {
  const authentication = draft.authentication ?? (draft.keyHome ? "remote" : "connecting");
  return {
    kind: "ssh",
    name: name.trim(),
    description: description.trim() || null,
    nodeId: draft.nodeId,
    destination: draft.expectedDestination ?? sshDestination(draft),
    ...(draft.resolutionAlias ? { resolutionAlias: draft.resolutionAlias } : {}),
    ...(draft.expectedDestination ? { expectedDestination: draft.expectedDestination } : {}),
    alias: draft.destination.pick?.aliasToken ?? null,
    authentication,
    keyHome: authentication === "remote" ? draft.keyHome : null,
    fingerprints: authentication === "remote" ? (draft.selections[draft.keyHome] ?? []) : [],
  };
}
