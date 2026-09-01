import { SharingDialogCore } from "@/components/sharing-dialog-core";
import { type ShareDraft, useSetShares, useSharableUsers, useShares } from "@/hooks/use-session-shares";

/**
 * Session sharing control (spec 2026-08-31 §4) — the thin session-flavoured
 * wrapper around {@link SharingDialogCore}: it owns the session-shares hooks
 * and the copy, and keeps the EXACT props every call site already passes
 * (`sessionId` + open state). Nodes use `NodeSharingDialog`
 * (`components/nodes/node-sharing-dialog.tsx`), which shares the same core.
 *
 * Owner-only in practice — opened from the session's actions menu — so
 * `canManage` stays at the core's default.
 */
export function SharingDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shares = useShares(sessionId, open);
  const roster = useSharableUsers(open);
  const setShares = useSetShares(sessionId);

  const serverGrants: ShareDraft[] = (shares.data?.shares ?? []).map((s) => ({
    granteeUserId: s.granteeUserId,
    permission: s.permission,
  }));

  return (
    <SharingDialogCore
      open={open}
      onOpenChange={onOpenChange}
      title="Share session"
      description="Let others see or use this session. Sharing is private by default."
      isLoading={shares.isLoading}
      serverGrants={serverGrants}
      roster={roster.data ?? []}
      saving={setShares.isPending}
      onSave={(grants) => setShares.mutateAsync(grants)}
    />
  );
}
