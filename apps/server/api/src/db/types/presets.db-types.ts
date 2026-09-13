/**
 * Database table schema for harness presets.
 *
 * A preset is saved launch customisation for one harness: extra environment
 * variables, CLI flags, a settings JSON blob, config-source isolation, and the
 * auto-restart policy new subshells inherit. That is its whole job — launching
 * without one is a real path (spec 2026-09-13), so a fresh instance has zero
 * rows here and can launch immediately. All presets belong to a user
 * (multi-user ready).
 */
export interface PresetTable {
  /** Unique preset id (uuid) */
  id: string;
  /** Owning user id (better-auth user id) */
  userId: string;
  /** Harness plugin id this preset applies to, e.g. "claude-code" */
  harnessId: string;
  /**
   * Human-friendly preset name. NOT unique: `idx_presets_user_harness` is a
   * lookup index, not a constraint, and create performs no duplicate check, so
   * one user can hold two presets with the same name for one harness. Anything
   * that ADDRESSES a preset by name (the MCP tools) must therefore refuse a
   * tie rather than take the first row — launching the wrong preset writes the
   * wrong credential layer.
   */
  name: string;
  /** Optional longer description */
  description: string | null;
  /** JSON object of extra environment variables to set on the subshell */
  envJson: string | null;
  /** JSON array of extra CLI flags to pass to the harness */
  flagsJson: string | null;
  /** JSON object of settings passed to the harness (e.g. claude --settings) */
  settingsJson: string | null;
  /** 1 = only this preset's config sources (no default ~/.claude files) */
  configIsolation: number;
  /** 1 = new subshells from this preset auto-restart on exit */
  restartOnExit: number;
  /** ISO 8601 timestamp when the preset was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill createdAt/updatedAt/restartOnExit when omitted. */
export type NewPreset = Omit<PresetTable, "createdAt" | "updatedAt" | "restartOnExit"> & {
  restartOnExit?: number;
};
export type PresetUpdate = Partial<Omit<NewPreset, "id" | "userId" | "harnessId">>;
