import type { ProfileDefinition, ProfileValidationIssue, ProfileValidationResult } from "./types.js";

/**
 * The profile checks every built-in harness performs unchanged: a non-empty
 * name, string env values, and flags that look like flags. Harnesses with
 * extra rules run their own checks on top of these.
 * @param profile - The decoded profile definition to check
 * @returns Issues per field; `valid` is true when no issues were found
 */
export function validateGenericProfile(profile: ProfileDefinition): ProfileValidationResult {
  const issues: ProfileValidationIssue[] = [];

  if (!profile.name || profile.name.trim().length === 0) {
    issues.push({ field: "name", message: "Profile name is required." });
  }

  for (const [key, value] of Object.entries(profile.env)) {
    if (typeof value !== "string") {
      issues.push({ field: "env", message: `Env var "${key}" must be a string.` });
    }
  }

  for (const flag of profile.flags) {
    if (!flag.startsWith("-")) {
      issues.push({ field: "flags", message: `Flag "${flag}" must start with "-".` });
    }
  }

  return { valid: issues.length === 0, issues };
}
