/**
 * A harness preset as returned by the presets API.
 * This is the client-facing subset of `PresetSchema` in the backend
 * (apps/server/api/src/api/models.ts): it carries the fields the frontend uses
 * and omits `userId`.
 */
export interface PresetRow {
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
   *  only when this AND the three launch fields are filled. */
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
