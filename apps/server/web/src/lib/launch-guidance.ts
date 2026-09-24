import type { PublicSettings } from "@/hooks/use-public-settings";

/**
 * Whether the Server is currently a launch target, per the shared public
 * read (the `allow_server_subshells` setting).
 *
 * UNANSWERED means ON — an absent field is a server older than the setting,
 * an empty payload is one in flight, and the server's own absent row is
 * true. Reading either as OFF would flash the guidance card onto every page
 * load and retract it when the request lands; this is the exact unknown
 * discipline `node-enrollment.ts` records for its own flag.
 */
export function serverSubshellsOn(
  settings: Partial<Pick<PublicSettings, "allowServerSubshells">> | undefined,
): boolean {
  return settings?.allowServerSubshells !== false;
}

/** What the Subshells page says when NOTHING can run subshells. */
export interface LaunchGuidance {
  headline: string;
  description: string;
  actionLabel: string;
  /** A path, navigated to by the route — a real page on every branch. */
  actionTo: "/nodes";
}

/**
 * The home page's "There are no nodes available" guidance, or null to show
 * the ordinary empty state (operator ask, 2026-09-24).
 *
 * Shown only when all three hold: the nodes read has ANSWERED (silence
 * while loading — a card that retracts is worse than a beat of the ordinary
 * state), the Server is switched off as a target, and there is no AGENT row
 * at all. An existing agent — offline, maintained, unshared — keeps the
 * ordinary empty state, because its rows and the launch form's per-machine
 * reasons already say what is in the way; this card answers a question those
 * surfaces cannot, because there is nothing on them.
 *
 * The copy branches on `canAdd` (the caller's `canAddNode` answer): a
 * viewer who may mint a setup key is pointed at adding one, a viewer who
 * may not is told who can. Both buttons go to `/nodes` — for the fixer it
 * holds the Add-node dialog, for the asker the machine list they will
 * quote. A button that went nowhere for the person who cannot act would be
 * the "offer that ends nowhere" the launch form already refuses.
 */
export function launchGuidance(input: {
  nodesLoaded: boolean;
  agentNodeCount: number;
  settings: Pick<PublicSettings, "allowServerSubshells"> | Partial<PublicSettings> | undefined;
  canAdd: boolean;
}): LaunchGuidance | null {
  if (!input.nodesLoaded) return null;
  if (serverSubshellsOn(input.settings)) return null;
  if (input.agentNodeCount > 0) return null;
  return input.canAdd
    ? {
        headline: "There are no nodes available",
        description:
          "The server is switched off as a place to run subshells, and no node you can launch on has been added. Add a machine, or turn the server back on in its settings.",
        actionLabel: "Go to Nodes",
        actionTo: "/nodes",
      }
    : {
        headline: "There are no nodes available",
        description: "There are no nodes available that can start subshells. Contact your admin to add a node.",
        actionLabel: "View nodes",
        actionTo: "/nodes",
      };
}
