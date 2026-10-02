import { createFileRoute } from "@tanstack/react-router";
import { CreateBackupCard } from "@/components/backups/create-backup-card";
import { RestoreBackupCard } from "@/components/backups/restore-backup-card";
import { PageHeader } from "@/components/page-header";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/backups")({ component: BackupsPage });
function BackupsPage() {
  const { data } = usePublicSettings();
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Backups" subtitle="Save this server's state and restore it on this machine or another." />
      {data?.viewerIsAdmin === true ? (
        <>
          <CreateBackupCard />
          <RestoreBackupCard />
        </>
      ) : data?.viewerIsAdmin === false ? (
        <p className="text-body text-muted-foreground">Backups are available to instance administrators.</p>
      ) : null}
    </main>
  );
}
