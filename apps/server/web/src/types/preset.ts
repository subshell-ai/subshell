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
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 update timestamp */
  updatedAt: string;
}
