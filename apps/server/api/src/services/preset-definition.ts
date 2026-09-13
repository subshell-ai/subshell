/**
 * The preset half of a launch definition: the emptiness a presetless launch
 * composes from, and the row → {@link PresetDefinition} parse. Its own module
 * rather than a tail of `subshell-manager.service.ts` because `EMPTY_PRESET`
 * is a spec-named concept (2026-09-13 §4) that four test files across three
 * directories reach for, and that file is already far past the size the
 * style rule asks for.
 */
import type { PresetDefinition } from "@internal/pane-runtime";

/**
 * The launch definition of a subshell created without a preset: adds nothing,
 * isolates nothing. Frozen DEEP — a shallow freeze would leave
 * `EMPTY_PRESET.env.X = …` writable on the one object every presetless launch
 * shares (consumers verified read-only; this is belt-and-braces). The exported
 * type stays the published mutable `PresetDefinition`: this is a runtime
 * guard, not a contract change.
 */
const emptyPreset: PresetDefinition = {
  name: "",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};
Object.freeze(emptyPreset.env);
Object.freeze(emptyPreset.flags);
export const EMPTY_PRESET: PresetDefinition = Object.freeze(emptyPreset);

/** Parses a preset row's JSON blobs into the plugin-facing shape. */
export function parsePreset(row: {
  envJson: string | null;
  flagsJson: string | null;
  settingsJson: string | null;
  configIsolation: number;
  restartOnExit?: number;
  name: string;
  description?: string | null;
}): PresetDefinition {
  return {
    name: row.name,
    description: row.description ?? null,
    env: row.envJson ? (JSON.parse(row.envJson) as Record<string, string>) : {},
    flags: row.flagsJson ? (JSON.parse(row.flagsJson) as string[]) : [],
    settings: row.settingsJson ? (JSON.parse(row.settingsJson) as Record<string, unknown>) : null,
    configIsolation: row.configIsolation === 1,
    restartOnExit: row.restartOnExit === 1,
  };
}
