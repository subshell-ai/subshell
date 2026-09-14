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
   * Human-friendly preset name, UNIQUE per (user, harness) and
   * case-insensitively so — `idx_presets_user_harness_name`, a NOCASE unique
   * index (migration 0028); create and rename answer 409 on a collision, as
   * workspaces do for their own label.
   *
   * `0001-init.ts` claimed this invariant while enforcing nothing, which is
   * how the MCP's name lookup came to pick whichever row sorted first. That
   * lookup still refuses a tie rather than trusting this line: it runs
   * against whatever list the server returns, and a guarantee held by an
   * index on another machine is not one the caller can check.
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
