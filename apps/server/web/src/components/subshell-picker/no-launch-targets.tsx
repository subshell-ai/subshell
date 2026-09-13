import { useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode } from "@/lib/node-enrollment";
import type { Node } from "@/types/node";

/**
 * What the launch form says when there is nowhere to launch.
 *
 * Two things have to be true at once for this to appear: launching on the
 * control-plane host is switched off, and this viewer has no node of their
 * own. Before the switch applied to admins (2026-09-12) the second half was
 * the only way in, so the person who saw this was always the person who could
 * not fix it; now the admin who switched it off sees it too, and for them the
 * first button is the way back.
 *
 * **Both routes are offered to everyone who can take them.** Adding a node
 * needs a signed-in cookie AND the instance's `allow_node_enrollment`
 * setting, which an admin can turn off; switching the host back on is a
 * manage act on the `local` row. Each button appears only for a viewer who
 * could actually complete it, and a viewer who cannot gets the sentence
 * naming who can — an offer that ends in a 403 is worse than no offer.
 *
 * The node button is NOT hidden merely because the settings request has not
 * answered yet: absent reads as allowed, the same default the server applies
 * to an absent row, so the control does not flicker away on every load.
 */
export function NoLaunchTargets({ local, onNavigate }: { local: Node | null; onNavigate?: () => void }): JSX.Element {
  const navigate = useNavigate();
  const { data: publicSettings } = usePublicSettings();
  const mayAddNode = canAddNode(publicSettings);

  /**
   * Leave for a page that can fix this — closing whatever contains us first.
   *
   * `QuickAddProvider` mounts the launch and workspace dialogs ABOVE every
   * route (`routes/__root.tsx`), so on the rail's quick-add and on `/new` the
   * route changes UNDERNEATH a modal that stays up — still showing this same
   * empty state, over the page that was supposed to be the answer. A way out
   * that appears to do nothing is the exact failure this component exists to
   * remove.
   */
  function leaveFor(go: () => void): void {
    onNavigate?.();
    go();
  }
  const canEnableHost = local?.canManage === true;
  // The host's row is admin-named and defaults to "Server" — never the id,
  // which is `local` and is an identifier rather than a label.
  const hostName = local?.name ?? "the server";

  return (
    <div className="space-y-4 rounded-lg border border-dashed p-6 text-center">
      <div className="space-y-1">
        <p className="font-medium text-sm">No machine can run a subshell</p>
        <p className="text-muted-foreground text-sm">
          {local
            ? `Launching on ${hostName} is switched off, and no other machine is registered as a node.`
            : mayAddNode
              ? "No machine is available to you. Register one as a node, or ask an admin to switch launching on the server back on."
              : // Told to "register one as a node" with no button and no
                // permission, this named the one route it had just hidden.
                "No machine is available to you. Ask an admin to add one, or to switch launching on the server back on."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canEnableHost && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: "/nodes/$id", params: { id: local.id } })}
          >
            Enable on {hostName}
          </Button>
        )}
        {mayAddNode && (
          <Button variant="outline" size="sm" onClick={() => leaveFor(() => void navigate({ to: "/nodes" }))}>
            Add a node
          </Button>
        )}
      </div>
      {local && !canEnableHost && (
        <p className="text-muted-foreground text-xs">An admin can switch {hostName} back on from its node page.</p>
      )}
      {/* Every hidden route owes a sentence naming who can take it — that is
          the rule this component's docblock states, and the node route was
          the half not honouring it. */}
      {!mayAddNode && (
        <p className="text-muted-foreground text-xs">
          Adding nodes is turned off on this instance; an admin can add one.
        </p>
      )}
    </div>
  );
}
