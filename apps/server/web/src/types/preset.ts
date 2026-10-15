/**
 * A harness preset as returned by the presets API.
 * This is the client-facing subset of `PresetSchema` in the backend
 * (apps/server/api/src/api/models.ts): it carries the fields the frontend uses
 * and omits `userId`.
 */
export interface AgentPreset {
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
export interface SshPreset {
  kind: "ssh";
  id: string;
  name: string;
  description: string | null;
  nodeId: string | null;
  destination: string;
  alias: string | null;
  /** Original SSH token, reused only under the saved canonical destination guard. */
  resolutionAlias?: string | null;
  authentication: SshAuthentication;
  keyHome: string | null;
  fingerprints: string[];
  createdAt: string;
  updatedAt: string;
}

export type LaunchPreset = AgentPreset | SshPreset;
export type SshPresetPayload = Pick<
  SshPreset,
  "name" | "description" | "destination" | "alias" | "resolutionAlias" | "authentication" | "keyHome" | "fingerprints"
> & { kind: "ssh"; nodeId: string; expectedDestination?: string };
