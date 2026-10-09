import { Button, CardTitle } from "@internal/node-admin";
import type { SshMachineReadiness } from "@/lib/ssh";

/** One setup entry point even when every existing machine is blocked. */
export function NoSshTargets({ machines, onWizard }: { machines: SshMachineReadiness[]; onWizard: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed p-6">
      <CardTitle>No machine is ready for SSH</CardTitle>
      <p className="text-detail text-muted-foreground">
        An SSH terminal needs an online Subshell machine with SSH enabled to connect from. The wizard can prepare an
        existing machine or help you add one.
      </p>
      {machines.map(({ node, blockers }) => (
        <p key={node.id} className="text-detail">
          {node.name}: {blockers.map((blocker) => blocker.message).join(" ")}
        </p>
      ))}
      <Button type="button" className="self-start" onClick={onWizard}>
        SSH Wizard
      </Button>
    </div>
  );
}
