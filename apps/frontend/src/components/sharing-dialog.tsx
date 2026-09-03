import { SharingDialogCore } from "@/components/sharing-dialog-core";
import { type ShareDraft, useSetShares, useSharableUsers, useShares } from "@/hooks/use-subshell-shares";

/**
 * Subshell sharing control (spec 2026-08-31 §4) — the thin subshell-flavoured
 * wrapper around {@link SharingDialogCore}: it owns the subshell-shares hooks
 * and the copy, and keeps the EXACT props every call site already passes
 * (`subshellId` + open state). Nodes use `NodeSharingDialog`
 * (`components/nodes/node-sharing-dialog.tsx`), which shares the same core.
 *
 * Owner-only in practice — opened from the subshell's actions menu — so
 * `canManage` stays at the core's default.
 */
export function SharingDialog({
  subshellId,
  open,
  onOpenChange,
}: {
  subshellId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shares = useShares(subshellId, open);
  const roster = useSharableUsers(open);
  const setShares = useSetShares(subshellId);

  const serverGrants: ShareDraft[] = (shares.data?.shares ?? []).map((s) => ({
    granteeUserId: s.granteeUserId,
    permission: s.permission,
  }));

  return (
    <SharingDialogCore
      open={open}
      onOpenChange={onOpenChange}
      title="Share subshell"
      description="Let others see or use this subshell. Sharing is private by default."
      isLoading={shares.isLoading}
      serverGrants={serverGrants}
      roster={roster.data ?? []}
      saving={setShares.isPending}
      onSave={(grants) => setShares.mutateAsync(grants)}
    />
  );
}
