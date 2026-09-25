import { EntryInputError, normalizeEntryOrigin } from "@/auth/oidc-discovery.js";

/**
 * The name cap: the same 120 code points the subshell/workspace renames use.
 * The door's name is rendered on the ANONYMOUS sign-in buttons and inside
 * `heldEmailMessage`, so it goes through `normalizeLabel` + a cap like every
 * other user-visible NAME path (the security rule) — a `trim()` alone let the
 * control-char class the normalizer exists for reach the pre-auth surface.
 */
export const PROVIDER_NAME_MAX = 120;

/** The one refusal sentence every last-door guard shares (spec §8). */
export const LAST_DOOR_MESSAGE =
  "This would leave no way to sign in. Open another door first, or use SUBSHELL_EMERGENCY_PASSWORD from the CLI.";

/** Normalize a submitted origin list; the caller has already decided a default exists. */
export function normalizeOriginList(list: string[]): string[] {
  const seen: string[] = [];
  for (const entry of list) {
    const canonical = normalizeEntryOrigin(entry);
    if (!seen.includes(canonical)) seen.push(canonical);
  }
  if (seen.length === 0) {
    throw new EntryInputError("entry origins resolved to an empty list");
  }
  return seen;
}
