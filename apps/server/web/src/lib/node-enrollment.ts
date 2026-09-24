import type { PublicSettings } from "@/hooks/use-public-settings";

/**
 * Whether this viewer may add a node, as the SERVER decides it.
 *
 * Mirrors `POST /api/nodes/setup-keys`'s own gate — the `allow_node_enrollment`
 * setting, with admins exempt — so no surface offers a button the route
 * refuses. One function rather than the same expression written at each call
 * site: two surfaces apply this (the Nodes page and the launch picker's empty
 * state) and the UNKNOWN case below is the half a second copy gets wrong.
 *
 * **An unanswered settings read counts as ALLOWED.** The server treats an
 * absent row as true, and this has to agree: reading `undefined` as "off"
 * would hide the control from everyone on every load until the request
 * landed, flickering it away and back. The route is the real gate; this only
 * decides whether to offer.
 *
 * `Partial` for the same reason the unknown case exists: a payload in flight
 * has no fields, and one from a server older than this setting has no
 * `allowNodeEnrollment` — both of which must read as allowed rather than
 * taking the button away.
 */
export function canAddNode(
  settings: Partial<Pick<PublicSettings, "allowNodeEnrollment" | "viewerIsAdmin">> | undefined,
): boolean {
  return settings?.allowNodeEnrollment !== false || settings?.viewerIsAdmin === true;
}

/**
 * The ONE sentence that explains a gated "Add node" affordance, wording
 * settled on the launch form and reused verbatim by the Nodes page's
 * disabled-button tooltip (operator ask 2026-09-24: "use the same copy as
 * the subshell page"). Two surfaces, one string — a reworded second copy of
 * the same gate is how a product starts saying two things about one setting.
 */
export const NODE_ENROLLMENT_OFF_COPY = "Adding nodes is turned off on this instance; an admin can add one.";
