import type { NetworkRow } from "@/types/network";

/**
 * What stops this row's Connect / Sign-in buttons right now, or null.
 *
 * The server refuses a join with 409 `NETWORK_UNCONFIGURED` while a REQUIRED
 * NON-SECRET settings field is unset — `configurationRefusal`'s join variant,
 * which exempts the secret half precisely because the join is the act that
 * DELIVERS it. Headscale (a required control URL) and Cloudflare (three
 * required settings) therefore used to answer a press with a sentence pointing
 * at the page the press came from. This mirrors that rule exactly so the
 * button is disabled with the reason BEFORE rather than the refusal arriving
 * after.
 *
 * Satisfaction mirrors the server's too: a non-blank stored value, else a
 * non-blank declared `default` — the plugin will see that default, so demanding
 * someone retype what already configures it would refuse a working setup.
 * Fields are examined in declaration order and the first unset one is named,
 * because that is the one the server would refuse on first.
 */
export function connectBlocker(row: NetworkRow): string | null {
  for (const field of row.settingsFields) {
    if (!field.required || field.type === "secret") continue;
    const stored = row.settings[field.key];
    const set =
      (typeof stored === "string" && stored.trim() !== "") ||
      (field.default !== undefined && String(field.default).trim() !== "");
    if (!set) return `Set the ${field.label.toLowerCase()} first.`;
  }
  return null;
}
