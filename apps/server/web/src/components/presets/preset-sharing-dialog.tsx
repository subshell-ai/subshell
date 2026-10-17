import { Button } from "@internal/node-admin";
import { ErrorBanner } from "@/components/error-banner";
import { SharingDialogCore } from "@/components/sharing-dialog-core";
import { usePresetShares, useSetPresetShares } from "@/hooks/use-preset-shares";
import { useSharableUsers } from "@/hooks/use-subshell-shares";

export function PresetSharingDialog({ id, kind, onClose }: { id: string; kind: "agent" | "ssh"; onClose: () => void }) {
  const shares = usePresetShares(id, true);
  const roster = useSharableUsers(true);
  const save = useSetPresetShares(id);
  const failed = shares.isError || roster.isError;
  return (
    <SharingDialogCore
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Share preset"
      description="Presets are private by default. View access lets people inspect, use, and clone this preset. Edit access also lets them change it. Only you can share or delete it."
      warning={
        kind === "agent"
          ? "Sharing exposes all saved settings, including environment variables and any secrets in them. Edits affect future launches and restarts for everyone using this preset."
          : "Sharing exposes the destination and saved connection choices. It doesn't grant access to nodes, SSH keys, or destination approvals."
      }
      loadError={
        failed ? (
          <ErrorBanner
            message="Couldn't load sharing settings. Try again before making changes."
            action={
              <Button
                variant="link"
                onClick={() => {
                  void shares.refetch();
                  void roster.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : undefined
      }
      isLoading={shares.isPending || roster.isPending}
      serverGrants={shares.data?.shares ?? []}
      roster={roster.data ?? []}
      saving={save.isPending}
      onSave={(grants) => save.mutateAsync(grants)}
    />
  );
}
