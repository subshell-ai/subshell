import { Button, CardTitle } from "@internal/node-admin";
import type { SshMachineReadiness } from "@/lib/ssh";

/** One setup entry point even when every existing machine is blocked. */
export function NoSshTargets({ machines, onWizard }: { machines: SshMachineReadiness[]; onWizard: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed p-6">
      <CardTitle>Connect over SSH</CardTitle>
      <p className="text-detail text-muted-foreground">
        SSH connections start from one of your nodes. Set up an existing node or add one to connect to another machine.
      </p>
      {machines.map(({ node, blockers }) => (
        <p key={node.id} className="text-detail text-warning">
          {node.name}: {blockers.map((blocker) => blocker.message).join(" ")}
        </p>
      ))}
      <Button type="button" className="self-start" onClick={onWizard}>
        Set up SSH
      </Button>
    </div>
  );
}
