import type { ComboboxOption } from "@/components/ui/combobox";
import { nodeOptionLabel } from "@/lib/node-label";
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

/** Why a harness cannot launch on a node right now. */
export type IncompatReason = "offline" | "not-installed" | "disabled";

/**
 * Whether `harnessId` could launch on `node`, informational-grade:
 * offline agent beats entry state; absent entry counts as not-installed
 * (the lazy `enabledByDefault` rule never grants a launch the inventory
 * has not confirmed).
 * @returns null when usable, else the reason code
 */
export function harnessFitsNode(node: Node, harnessId: string): IncompatReason | null {
  if (node.kind === "agent" && node.status === "offline") return "offline";
  const entry = node.harnesses.find((h) => h.harnessId === harnessId);
  if (!entry?.installed) return "not-installed";
  if (!entry.enabled) return "disabled";
  return null;
}

/** The muted reason text on a greyed profile row (node must be non-null). */
function profileReasonText(node: Node, reason: IncompatReason): string {
  if (reason === "offline") return "node offline";
  if (reason === "disabled") return "disabled on this node";
  return node.inventoryStale ? "not installed here (inventory may be outdated)" : "not installed on this node";
}

/**
 * Profile options paired against the chosen node (null = no pick yet:
 * nothing greys). Labels keep the e2e-pinned `name (harnessId)` format.
 */
export function buildProfileOptions(profiles: readonly LaunchProfile[], node: Node | null): ComboboxOption[] {
  return profiles.map((p) => {
    const fit = node === null ? null : harnessFitsNode(node, p.harnessId);
    const opt: ComboboxOption = { value: p.id, label: `${p.name} (${p.harnessId})`, disabled: fit !== null };
    if (fit !== null && node !== null) opt.reason = profileReasonText(node, fit);
    return opt;
  });
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
  return nodes.map((n) => {
    const offline = n.kind === "agent" && n.status === "offline";
    const fit = !offline && profile !== null ? harnessFitsNode(n, profile.harnessId) : null;
    const label = nodeOptionLabel(n, "Local") + (n.id === suggestionId ? " · default for this profile" : "");
    const opt: ComboboxOption = { value: n.id, label, disabled: offline || fit !== null };
    if (fit !== null && profile !== null) opt.reason = `no ${profile.harnessId} here`;
    return opt;
  });
}
