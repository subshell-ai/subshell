import type { SshForwardWire } from "@internal/subshell-protocol";

/** Input accepted by the SSH preset workflow. HTTP validates the envelope; the workflow parses forwards. */
export interface SshPresetInput {
  /** Display name, unique for the owner. */
  name: string;
  /** Optional description; null clears it. */
  description?: string | null;
  /** Node that connects to the destination. */
  nodeId: string;
  /** Requested SSH destination. */
  destination: string;
  /** Original resolution token; omitted values retain the existing selection. */
  resolutionAlias?: string | null;
  /** Display-only alias. */
  alias?: string | null;
  /** Authentication mode for the connection. */
  authentication: "connecting" | "remote" | "local-key" | "password";
  /** Node holding selected keys. */
  keyHome?: string | null;
  /** Selected public key fingerprints. */
  fingerprints?: string[] | null;
  /** Forward rows before protocol validation; omitted preserves the existing list. */
  forwards?: (Omit<SshForwardWire, "kind"> & { kind: string })[] | null;
  /** Previously approved canonical destination. */
  expectedDestination?: string;
}
