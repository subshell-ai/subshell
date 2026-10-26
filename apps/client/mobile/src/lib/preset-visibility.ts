/**
 * Which preset rows a launch may offer.
 *
 * Hand-mirror of the web launch pickers' filter (spec 2026-10-24: the enable
 * switch; change one, change both): a disabled preset is invisible in every
 * launch surface, and the server refuses to launch from one anyway. This
 * drops rows from the chip list only; the store keeps the full rows, so the
 * New screen's coherence guard reads a remote disable exactly like a remote
 * delete and un-picks a held preset through it.
 */
import type { PresetView } from "@/types/preset";

/**
 * True when one preset row is offered to a launch. The test is `!== 0`
 * rather than `=== 1` for the same reason the plugin-visibility precedent
 * offers rows whose `pickable` field is absent: an older server that never
 * heard of the switch sends no field, and those rows stay offered. Only a row
 * that actually says off (`0`) is dropped.
 */
export function isPresetOffered(preset: PresetView): boolean {
  return preset.enabled !== 0;
}
