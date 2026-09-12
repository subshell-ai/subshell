import { useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
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
 * needs only a signed-in cookie — setup keys are not admin-gated — so that
 * button is never hidden. Switching the host back on is a manage act on the
 * `local` row, so it appears only when the server says this viewer manages
 * it; a non-admin gets the sentence instead, which names who can.
 */
export function NoLaunchTargets({ local }: { local: Node | null }): JSX.Element {
  const navigate = useNavigate();
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
            : "No machine is available to you. Register one as a node, or ask an admin to switch launching on the server back on."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canEnableHost && local && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: "/nodes/$id", params: { id: local.id } })}
          >
            Enable on {hostName}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/nodes" })}>
          Add a node
        </Button>
      </div>
      {local && !canEnableHost && (
        <p className="text-muted-foreground text-xs">An admin can switch {hostName} back on from its node page.</p>
      )}
    </div>
  );
}
