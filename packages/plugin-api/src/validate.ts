import type { PresetDefinition, PresetValidationIssue, PresetValidationResult } from "./types.js";

/**
 * The preset checks every built-in harness performs unchanged: a non-empty
 * name, string env values, and flags that look like flags. Harnesses with
 * extra rules run their own checks on top of these.
 * @param preset - The decoded preset definition to check
 * @returns Issues per field; `valid` is true when no issues were found
 */
export function validateGenericPreset(preset: PresetDefinition): PresetValidationResult {
  const issues: PresetValidationIssue[] = [];

  if (!preset.name || preset.name.trim().length === 0) {
    issues.push({ field: "name", message: "Preset name is required." });
  }

  for (const [key, value] of Object.entries(preset.env)) {
    if (typeof value !== "string") {
      issues.push({ field: "env", message: `Env var "${key}" must be a string.` });
    }
  }

  for (const flag of preset.flags) {
    if (!flag.startsWith("-")) {
      issues.push({ field: "flags", message: `Flag "${flag}" must start with "-".` });
    }
  }

  return { valid: issues.length === 0, issues };
}
