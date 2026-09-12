import type { ComboboxOption } from "@/components/ui/combobox";
import { isOfflineAgent, nodeOptionLabel } from "@/lib/node-label";
import { usableFirst } from "@/lib/option-order";
import type { Node } from "@/types/node";
import type { ProfileRow } from "@/types/profile";

/**
 * The launch picker's compatibility matrix (spec 2026-09-02 §2), pure so the
 * grey-with-reason grid is testable without opening a Base UI dropdown.
 * This is the INFORMATIONAL mirror of the server's `harnessUsable` — the
 * launch gate stays authoritative server-side (409 harness_disabled covers
 * every race, including a stale agent inventory).
 */

/** The profile fields the launch pickers read. */
export type LaunchProfile = Pick<ProfileRow, "id" | "name" | "harnessId" | "nodeId">;

/**
 * Why a profile cannot launch on a node.
 *
 * "disabled" is gone (spec 2026-09-09 §12): a node offers what it has
 * INSTALLED, so there is no enable flag left to be off. What used to be a
 * disabled harness is now simply a plugin the node does not have, which is
 * "not-installed" and already the row a reader sees.
 */
export type IncompatReason = "offline" | "not-installed";

/**
 * Whether `harnessId` could launch on `node`, informational-grade: an offline
 * agent beats entry state, and an absent entry counts as not-installed — the
 * node either declared the plugin and its binary was seen, or it did not.
 * @returns null when usable, else the reason code
 */
export function harnessFitsNode(node: Node, harnessId: string): IncompatReason | null {
  if (isOfflineAgent(node)) return "offline";
  const entry = node.harnesses.find((h) => h.harnessId === harnessId);
  if (!entry?.installed) return "not-installed";
  return null;
}

/**
 * The hedge both sides of the matrix append when a grey rests on STALE
 * inventory: a missing entry there is last-known state, not a confirmed fact.
 */
const STALE_HEDGE = " (inventory may be outdated)";

/** The muted reason text on a greyed profile row (node must be non-null). */
function profileReasonText(node: Node, reason: IncompatReason): string {
  if (reason === "offline") return "node offline";
  return node.inventoryStale ? `not installed here${STALE_HEDGE}` : "not installed on this node";
}

/**
 * The one profile-label grammar for every picker/reader: `name (harnessId)`
 * (e2e-pinned format). Shared by {@link buildProfileOptions} and the clone
 * dialog so the rows cannot drift.
 */
export function profileOptionLabel(p: LaunchProfile): string {
  return `${p.name} (${p.harnessId})`;
}

/**
 * Profile options paired against the chosen node (null = no pick yet:
 * nothing greys). Labels keep the e2e-pinned `name (harnessId)` format.
 */
export function buildProfileOptions(profiles: readonly LaunchProfile[], node: Node | null): ComboboxOption[] {
  return usableFirst(
    profiles.map((p) => {
      const fit = node === null ? null : harnessFitsNode(node, p.harnessId);
      const opt: ComboboxOption = { value: p.id, label: profileOptionLabel(p), disabled: fit !== null };
      if (fit !== null && node !== null) opt.reason = profileReasonText(node, fit);
      return opt;
    }),
    (o) => !o.disabled,
  );
}

/**
 * Node options paired against the chosen profile (null = no pick yet:
 * only offline agents grey). `suggestionId` — the pinned node AFTER the
 * caller has validated the suggestion (selectable + compatible, §1) — gets
 * the " · default for this profile" suffix.
 */
export function buildNodeOptions(
  nodes: readonly Node[],
  profile: LaunchProfile | null,
  suggestionId: string | null,
): ComboboxOption[] {
  return usableFirst(
    nodes.map((n) => {
      const offline = isOfflineAgent(n);
      const fit = !offline && profile !== null ? harnessFitsNode(n, profile.harnessId) : null;
      const label = nodeOptionLabel(n) + (n.id === suggestionId ? " · default for this profile" : "");
      const opt: ComboboxOption = { value: n.id, label, disabled: offline || fit !== null };
      if (fit !== null && profile !== null) {
        const stale = fit === "not-installed" && n.inventoryStale;
        opt.reason = `no ${profile.harnessId} here${stale ? STALE_HEDGE : ""}`;
      }
      return opt;
    }),
    (o) => !o.disabled,
  );
}
