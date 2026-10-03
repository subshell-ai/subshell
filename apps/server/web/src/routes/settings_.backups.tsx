import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CreateBackupCard } from "@/components/backups/create-backup-card";
import { RestoreBackupCard } from "@/components/backups/restore-backup-card";

import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useRestoreProgressActive } from "@/lib/restore-progress";

export const Route = createFileRoute("/settings_/backups")({ component: BackupsPage });
function BackupsPage() {
  const [operation, setOperation] = useState<"backup" | "restore">("backup");
  const [busy, setBusy] = useState(false);
  const { data } = usePublicSettings();
  const restoring = useRestoreProgressActive();
  return (
    <main className="flex h-full min-h-0 w-full flex-col">
      {data?.viewerIsAdmin === true || restoring ? (
        <>
          <div className="px-8 pt-6">
            <PageHeader title="Backups" />
          </div>
          <fieldset disabled={busy} className="shrink-0 border-b px-8 py-3">
            <Segmented
              ariaLabel="Backup operation"
              fill={false}
              options={[
                { value: "backup", label: "Backup" },
                { value: "restore", label: "Restore" },
              ]}
              value={operation}
              onChange={setOperation}
            />
          </fieldset>
          <section
            hidden={operation !== "backup"}
            className={operation === "backup" ? "flex min-h-0 flex-1 flex-col" : undefined}
          >
            <CreateBackupCard onBusy={setBusy} />
          </section>
          <section
            hidden={operation !== "restore"}
            className={operation === "restore" ? "flex min-h-0 flex-1 flex-col" : undefined}
          >
            <RestoreBackupCard onBusy={setBusy} />
          </section>
        </>
      ) : data?.viewerIsAdmin === false ? (
        <p className="text-body text-muted-foreground">Backups are available to instance administrators.</p>
      ) : null}
    </main>
  );
}
