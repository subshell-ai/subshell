import type { DestinationCandidate } from "@/components/connect/destination-options";
import { type SshAgentIdentity, type SshMachineReadiness, sshSelectionError } from "@/lib/ssh";

export type SshWizardIntent = "connect" | "prepare" | "remote-keys";
export type SshInitialChoices = { node?: string; destination?: string; keyHome?: string; fingerprints?: string[] };

/** A dialog owns this draft across form, wizard, and parent mode changes. */
export interface SshSessionDraft {
  /** Machine that runs SSH. Empty means no deliberate choice yet. */
  nodeId: string;
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
    return "A selected key is no longer available. Restore it to the SSH agent or explicitly update your selection.";
  return null;
}

export function sshKeySourceProblem(draft: SshSessionDraft): string | null {
  return draft.keyHome && draft.keyHome === draft.nodeId
    ? "The selected key machine is also the connecting machine. Explicitly choose the connecting machine’s own keys or another key machine to continue. Your selected fingerprints are preserved."
    : null;
}

export function sshDraftProblems(draft: SshSessionDraft): Record<string, string> {
  if (!draft.nodeId) return { node: "Choose a connecting machine first." };
  if (!sshDestination(draft)) return { destination: "Enter an SSH destination." };
  const error =
    sshKeySourceProblem(draft) ||
    (draft.keyHome ? sshKeySelectionProblem(draft.selections[draft.keyHome] ?? []) : null);
  return error ? { keys: error } : {};
}

export type SshWizardStep =
  | "intent"
  | "destination"
  | "machine"
  | "enrollment"
  | "machine-setup"
  | "key-choice"
  | "key-source"
  | "key-setup"
  | "keys"
  | "review"
  | "readiness";
export const SSH_STEP_LABELS: Record<SshWizardStep, string> = {
  intent: "What would you like to do?",
  destination: "Choose a destination",
  machine: "Choose a connecting machine",
  enrollment: "Add a machine",
  "machine-setup": "Prepare the connecting machine",
  "key-choice": "Choose where your keys live",
  "key-source": "Choose a key machine",
  "key-setup": "Prepare the key machine",
  keys: "Choose SSH agent keys",
  review: "Review your connection",
  readiness: "Your SSH setup",
};

/** Stable step ids keep a disappearing prerequisite from changing the current screen. */
export function sshWizardSteps(
  intent: SshWizardIntent | null,
  draft: SshSessionDraft,
  machines: SshMachineReadiness[],
  current: SshWizardStep,
  adding: boolean,
): SshWizardStep[] {
  if (!intent) return ["intent"];
  const machine = machines.find((m) => m.node.id === draft.nodeId);
  const key = machines.find((m) => m.node.id === draft.keyHome);
  const steps: SshWizardStep[] = ["intent"];
  if (intent === "connect") steps.push("destination");
  steps.push("machine");
  if (adding) steps.push("enrollment");
  if (!machine?.canConnect || current === "machine-setup") steps.push("machine-setup");
  if (intent === "connect") steps.push("key-choice");
  if (intent === "remote-keys" || (intent === "connect" && (draft.keyHome || current === "key-source"))) {
    steps.push("key-source");
    if (!key?.canConnect || current === "key-setup") steps.push("key-setup");
    steps.push("keys");
  }
  steps.push(intent === "connect" ? "review" : "readiness");
  return steps;
}
