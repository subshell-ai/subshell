import { join } from "node:path";

/**
 * Expands a leading `~`/`~/…` into an absolute path rooted at `home`,
 * so path lookups treat user-home shorthand like a real directory. Leaves
 * everything else untouched.
 *
 * @param input - Path as typed by the user (may be empty, relative, absolute, or `~`-prefixed)
 * @param home - Absolute home directory used as the `~` root
 * @returns The expanded path, or the input unchanged when it is not a tilde form
 */
export function expandTilde(input: string, home: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~" + "/")) {
    return join(home, trimmed.slice(2));
  }
  return input;
}
