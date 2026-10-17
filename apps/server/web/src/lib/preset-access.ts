import type { PresetSharing } from "@/types/preset";

/** Servers predating preset sharing return owned rows without access metadata. */
export const canEditPreset = (preset: PresetSharing) => preset.access !== "view";
export const ownsPreset = (preset: PresetSharing) => !preset.access || preset.access === "owner";
export function presetChoiceLabel(preset: PresetSharing & { name: string }) {
  return ownsPreset(preset)
    ? preset.name
    : `${preset.name} (shared by ${preset.ownerName ?? preset.userId ?? "another user"})`;
}
