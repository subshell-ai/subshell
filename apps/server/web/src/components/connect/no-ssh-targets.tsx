import { Button, CardTitle } from "@internal/node-admin";

/** One setup entry point even when every existing machine is blocked. */
export function NoSshTargets({ onWizard }: { onWizard: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed p-6">
      <CardTitle>Connect over SSH</CardTitle>
      <p className="text-detail text-warning">None of your nodes can start an SSH connection yet.</p>
      <p className="text-detail text-muted-foreground">Set up an existing node or add one to get started.</p>
      <Button type="button" className="self-start" onClick={onWizard}>
        Set up SSH
      </Button>
    </div>
  );
}
