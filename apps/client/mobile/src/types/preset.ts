/**
 * Hand-written mirror of `GET /api/presets` (spec 2026-09-13: presets replaced
 * profiles — the launch is harness-first and the preset is optional). Same
 * "deliberate subset of the wire row" convention as every file in `src/types/`.
 */

/** One preset as the API returns it (mirror of `PresetSchema`; only the fields this app renders). */
export interface PresetView {
  /** Preset id (uuid) — the create-subshell body carries it as `presetId` */
  id: string;
  /** Owning user id */
  userId: string;
  /** Harness plugin id, e.g. `claude-code` — what the Preset row filters the list by */
  harnessId: string;
  /** Display name */
  name: string;
  /** Longer description (nullable) */
  description: string | null;
  /** 1 = subshells launched from this preset auto-restart on exit */
  restartOnExit: number;
}
