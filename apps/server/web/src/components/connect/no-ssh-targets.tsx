import { Button, CardTitle } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode, NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import type { SshMachineReadiness } from "@/lib/ssh";

/** Keep setup reachable without asking for a destination that cannot be used. */
export function NoSshTargets({ machines, onLeave }: { machines: SshMachineReadiness[]; onLeave?: () => void }) {
  const navigate = useNavigate();
  function leaveFor(go: () => void): void {
    onLeave?.();
    go();
  }
  const { data: settings } = usePublicSettings();
  const mayAdd = canAddNode(settings);
  const manageable = machines.filter((machine) => machine.canConfigure);
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed p-6">
      <CardTitle>No machine is ready for SSH</CardTitle>
      <p className="text-detail text-muted-foreground">
        An SSH terminal needs an online Subshell machine with SSH enabled to connect from.
        {manageable.length === 0 &&
          (mayAdd
            ? " Add a machine you own and enable SSH on it."
            : " Ask an admin to allow node enrollment so you can add a machine you own.")}
      </p>
      {machines.map(({ node, canConfigure, blockers }) => (
        <div key={node.id} className="flex flex-col gap-1">
          <p className="text-detail">
            {node.name}: {blockers.map((blocker) => blocker.message).join(" ")}
          </p>
          {canConfigure && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => leaveFor(() => void navigate({ to: "/nodes/$id", params: { id: node.id } }))}
            >
              Open {node.name} settings
            </Button>
          )}
        </div>
      ))}
      {mayAdd ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => leaveFor(() => void navigate({ to: "/nodes" }))}
        >
          Add a node
        </Button>
      ) : (
        <p className="text-detail text-muted-foreground">{NODE_ENROLLMENT_OFF_COPY}</p>
      )}
    </div>
  );
}
