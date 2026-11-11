import { semverLt } from "@internal/subshell-protocol";
import { packageJsonText, readBuiltIn } from "./builtin-source.js";

/**
 * Whether the copy installed on this machine should stand instead of the one
 * this build carries.
 *
 * Only a STRICTLY newer installed version wins: an equal version is already
 * whatever the build ships, and rolling back to it would silently discard a
 * local pin the operator made on purpose. An empty installed version means
 * "there is no installed copy" (or a record we could not read), never a
 * version older than everything, so it never wins.
 */
export function installedCopyWins(bundledVersion: string, installedVersion: string): boolean {
  return installedVersion !== "" && semverLt(bundledVersion, installedVersion);
}

/**
 * The `version` in the `package.json` of the built-in `id` this build carries,
 * or null when this build does not carry it.
 *
 * Read through `readBuiltIn` so the answer follows the same source order an
 * install does: the checkout when there is one, the embedded copies in a
 * compiled binary. A `package.json` that cannot be parsed, or that has no
 * usable `version`, answers null — "unknown" is the honest answer, and callers
 * that cannot tell which copy is newer must not pretend one is.
 */
export async function bundledPluginVersion(id: string): Promise<string | null> {
  const source = await readBuiltIn(id);
  if (source === null) return null;
  try {
    const { version } = JSON.parse(packageJsonText(source.files)) as { version?: unknown };
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}
