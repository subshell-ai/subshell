import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CreateBackupCard } from "@/components/backups/create-backup-card";
import { RestoreBackupCard } from "@/components/backups/restore-backup-card";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/backups")({ component: BackupsPage });
function BackupsPage() {
  const [operation, setOperation] = useState<"backup" | "restore">("backup");
  const [busy, setBusy] = useState(false);
  const { data } = usePublicSettings();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <PageHeader title="Backups" subtitle="Save this server's state and restore it on this machine or another." />
      {data?.viewerIsAdmin === true ? (
        <>
          <fieldset disabled={busy}>
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
    </main>
  );
}
