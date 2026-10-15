import type { DestinationCandidate } from "@/components/connect/destination-options";
import { type SshAgentIdentity, sshSelectionError } from "@/lib/ssh";
import { type SshForwardDraftRow, sshForwardListProblems } from "@/lib/ssh-forwards";
import { sshDestinationProblem, sshPresetNameProblem } from "@/lib/ssh-input-validation";

export type SshInitialChoices = {
  preset?: string;
  node?: string;
  destination?: string;
  keyHome?: string;
  fingerprints?: string[];
};

/** A dialog owns this draft across form, wizard, and parent mode changes. */
export interface SshSessionDraft {
  /** Machine that runs SSH. Empty means no deliberate choice yet. */
  nodeId: string;
  /** Authentication preference only; credentials are entered in the terminal. */
  authentication?: "connecting" | "remote" | "password" | "local-key";
  /** Explicit key machine; retain it even if the connecting machine changes to this id. Empty means own keys. */
  keyHome: string;
  /** Explicit selections, separately scoped to each key machine. */
  selections: Record<string, string[]>;
  /** Display text and canonical suggestion travel together. */
  destination: { pick: DestinationCandidate | null; pickId: string | null; typed: string };
  initialPresetId?: string;
  /** Reuse alias-scoped settings while requiring the preset’s saved address. Destination edits clear both. */
  resolutionAlias?: string;
  expectedDestination?: string;
  /** Prevent default-node seeding from replacing a preset’s missing node. */
  presetApplied?: boolean;
  saveAsPreset?: boolean;
  presetName?: string;
  /** Declared port forwards as FORM rows (strings; untyped rows are ignored). Spec 2026-10-15. */
  forwards: SshForwardDraftRow[];
}

export function sshSessionDraft(initial?: SshInitialChoices): SshSessionDraft {
  return {
    nodeId: initial?.node ?? "",
    keyHome: initial?.keyHome ?? "",
    selections: initial?.keyHome ? { [initial.keyHome]: initial.fingerprints ?? [] } : {},
    destination: {
      pick: initial?.destination ? { destination: initial.destination } : null,
      pickId: null,
      typed: initial?.destination ?? "",
    },
    initialPresetId: initial?.preset,
    forwards: [],
  };
}

export function sshDestination(draft: SshSessionDraft): string {
  return draft.resolutionAlias ?? draft.destination.pick?.destination ?? draft.destination.typed.trim();
}

export function sshKeySelectionProblem(fingerprints: string[], identities?: SshAgentIdentity[]): string | null {
  if (fingerprints.length === 0) return "Choose at least one SSH agent key.";
  const cap = sshSelectionError(fingerprints);
  if (cap) return cap;
  if (identities && fingerprints.some((fingerprint) => !identities.some((key) => key.fingerprint === fingerprint)))
    return "A selected key is no longer available. Load it into the SSH agent again or choose different keys.";
  return null;
}

export function sshKeySourceProblem(draft: SshSessionDraft): string | null {
  return draft.keyHome && draft.keyHome === draft.nodeId
    ? "This machine is already selected under Connect from. Choose its own keys or a different machine. Your previous key selection is saved."
    : null;
}

export function sshDraftProblems(draft: SshSessionDraft): Record<string, string> {
  const nameProblem = draft.saveAsPreset ? sshPresetNameProblem(draft.presetName ?? "") : null;
  if (nameProblem) return { name: nameProblem };
  if (draft.authentication === "remote" && !draft.keyHome) return { keys: "Choose a node to supply keys." };
  if (!draft.nodeId) return { node: "Choose a node to connect from first." };
  const destinationProblem = sshDestinationProblem(sshDestination(draft));
  if (destinationProblem) return { destination: destinationProblem };
  const forwardProblem = sshForwardListProblems(draft.forwards);
  if (forwardProblem) return { forwards: forwardProblem };
  const error =
    sshKeySourceProblem(draft) ||
    (draft.keyHome ? sshKeySelectionProblem(draft.selections[draft.keyHome] ?? []) : null);
  return error ? { keys: error } : {};
}
