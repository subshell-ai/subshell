/**
 * A harness preset as returned by the presets API.
 * This is the client-facing subset of `PresetSchema` in the backend
 * (apps/server/api/src/api/models.ts): it carries the fields the frontend uses
 * including viewer-relative sharing metadata.
 */
import type { SshForwardRow } from "@/lib/ssh";

export interface PresetSharing {
  /** Omitted by older servers, which only return owned presets. */
  access?: "owner" | "edit" | "view";
  userId?: string;
  ownerName?: string;
}

export interface AgentPreset extends PresetSharing {
  kind: "agent";
  id: string;
  harnessId: string;
  name: string;
  description: string | null;
  envJson: string | null;
  flagsJson: string | null;
  settingsJson: string | null;
  configIsolation: number;
  restartOnExit: number;
  /** 1 = cross-subshell comms (MCP) enabled (migration 0043); the badge shows
   *  only when this AND a machine AND a directory are set (prompt optional). */
  crossCommEnabled: number;
  /** User-authored guidance for agents discovering this preset. */
  crossCommNotes?: string | null;
  /** Optional launch node hint (null = the preset names no machine) */
  nodeId: string | null;
  /** Optional absolute working directory (null = the preset names none) */
  workingDir: string | null;
  /** JSON prompt block stack, snapshot bodies (null = no prompt) */
  promptBlocks: string | null;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 update timestamp */
  updatedAt: string;
}

/** Legacy agent consumers use the agent-only list endpoint. */
export type PresetRow = Omit<AgentPreset, "kind"> & { kind?: "agent" };

export type SshAuthentication = "connecting" | "remote" | "local-key" | "password";

/** Saved connection choices only. Credentials and approvals never belong here. */
export interface SshPreset extends PresetSharing {
  kind: "ssh";
  /** Preset id */
  id: string;
  /** Display name, unique per owner */
  name: string;
  /** Optional longer description */
  description: string | null;
  /** Connecting node; null after that node's deletion */
  nodeId: string | null;
  /** Canonical resolved destination (`host:port` / `user@host:port`), never a raw typed token */
  destination: string;
  /** Display-only alias from the resolved snapshot; never used to re-resolve */
  alias: string | null;
  /** Original SSH token, reused only under the saved canonical destination guard. */
  resolutionAlias?: string | null;
  /** How the connection authenticates; the mode alone is saved, never a secret */
  authentication: SshAuthentication;
  /** Node providing the selected keys for `remote` authentication; null otherwise */
  keyHome: string | null;
  /** Selected public-key fingerprints (remote mode only); private keys stay on their machine */
  fingerprints: string[];
  /** Declared port forwards this preset carries to every launch; empty when it stores none (spec 2026-10-15) */
  forwards: SshForwardRow[];
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 update timestamp */
  updatedAt: string;
}

export type SshPresetPayload = Pick<
  SshPreset,
  | "name"
  | "description"
  | "destination"
  | "alias"
  | "resolutionAlias"
  | "authentication"
  | "keyHome"
  | "fingerprints"
  | "forwards"
> & { kind: "ssh"; nodeId: string; expectedDestination?: string };
