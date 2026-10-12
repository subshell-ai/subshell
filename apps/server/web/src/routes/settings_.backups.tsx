import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CreateBackupCard } from "@/components/backups/create-backup-card";
import { RestoreBackupCard } from "@/components/backups/restore-backup-card";
import { DashboardPage } from "@/components/dashboard-page";

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
    <DashboardPage>
      {data?.viewerIsAdmin === true || restoring ? (
        <>
          <PageHeader title="Backups" />
          <div>
            <Segmented
              ariaLabel="Backup operation"
              disabled={busy}
              disabledReason="Wait for the backup or restore operation to finish."
              fill={false}
              options={[
                { value: "backup", label: "Backup" },
                { value: "restore", label: "Restore" },
              ]}
              value={operation}
              onChange={setOperation}
            />
          </div>
          <section hidden={operation !== "backup"}>
            <CreateBackupCard onBusy={setBusy} />
          </section>
          <section hidden={operation !== "restore"}>
            <RestoreBackupCard onBusy={setBusy} />
          </section>
        </>
      ) : data?.viewerIsAdmin === false ? (
        <p className="text-body text-muted-foreground">Backups are available to instance administrators.</p>
      ) : null}
    </DashboardPage>
  );
}
