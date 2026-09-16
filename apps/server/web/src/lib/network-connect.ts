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
 *
 * **The verb is "Save", and the label keeps its own casing** (operator read,
 * 2026-09-16). The sentence fires in exactly one state: the field is typed
 * into the form and its SAVE button has not been pressed, or it was never
 * typed at all — so "Set the control server url first." pointed at an act
 * ("set") nothing on screen performs while the act that does (Save) went
 * unnamed. And the lowercasing mangled acronyms: the field is labelled
 * "Control server URL", and a sentence that renames the thing the form asks
 * for makes the reader hunt for a second field. Quoting the label verbatim
 * is what ties the sentence back to the control on screen.
 */
export function connectBlocker(row: NetworkRow): string | null {
  for (const field of row.settingsFields) {
    if (!field.required || field.type === "secret") continue;
    const stored = row.settings[field.key];
    const set =
      (typeof stored === "string" && stored.trim() !== "") ||
      (field.default !== undefined && String(field.default).trim() !== "");
    if (!set) return `Save the ${field.label} first.`;
  }
  return null;
}
