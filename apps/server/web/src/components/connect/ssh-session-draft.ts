import type { DestinationCandidate } from "@/components/connect/destination-options";
import { type SshAgentIdentity, sshSelectionError } from "@/lib/ssh";

export type SshInitialChoices = { node?: string; destination?: string; keyHome?: string; fingerprints?: string[] };

/** A dialog owns this draft across form, wizard, and parent mode changes. */
export interface SshSessionDraft {
  /** Machine that runs SSH. Empty means no deliberate choice yet. */
  nodeId: string;
  /** Authentication preference only; credentials are entered in the terminal. */
  authentication?: "password" | "local-key";
  /** Explicit key machine; retain it even if the connecting machine changes to this id. Empty means own keys. */
  keyHome: string;
  /** Explicit selections, separately scoped to each key machine. */
  selections: Record<string, string[]>;
  /** Display text and canonical suggestion travel together. */
  destination: { pick: DestinationCandidate | null; pickId: string | null; typed: string };
  /** Save this destination after a successful launch. */
  remember: boolean;
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
    remember: false,
  };
}

export function sshDestination(draft: SshSessionDraft): string {
  return draft.destination.pick?.destination ?? draft.destination.typed.trim();
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
  if (!draft.nodeId) return { node: "Choose a node to connect from first." };
  if (!sshDestination(draft)) return { destination: "Enter an SSH destination." };
  const error =
    sshKeySourceProblem(draft) ||
    (draft.keyHome ? sshKeySelectionProblem(draft.selections[draft.keyHome] ?? []) : null);
  return error ? { keys: error } : {};
}
