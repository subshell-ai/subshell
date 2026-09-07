import { SharingDialogCore } from "@/components/sharing-dialog-core";
import { useNodeShares, useSetNodeShares } from "@/hooks/use-node-shares";
import { type ShareDraft, useSharableUsers } from "@/hooks/use-subshell-shares";

/**
 * Node sharing control (spec 2026-08-31 §9/§10) — the node-flavoured wrapper
 * around {@link SharingDialogCore}. The contract mirrors subshell-shares
 * (Everyone + named users at view|edit, whole-set PUT), but both routes are
 * MANAGER-only (owner, or admin on `local`), so `canManage` comes from the
 * caller's already-loaded `Node.canManage` (server-derived — never re-derived
 * here) and gates the controls inside the core.
 */
export function NodeSharingDialog({
  nodeId,
  open,
  onOpenChange,
  canManage = true,
}: {
  /** Node whose grants this dialog edits ("local" included) */
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False renders the grant list read-only */
  canManage?: boolean;
}) {
  const shares = useNodeShares(nodeId, open);
  const roster = useSharableUsers(open);
  const setShares = useSetNodeShares(nodeId);

  const serverGrants: ShareDraft[] = (shares.data?.shares ?? []).map((s) => ({
    granteeUserId: s.granteeUserId,
    permission: s.permission,
  }));

  return (
    <SharingDialogCore
      open={open}
      onOpenChange={onOpenChange}
      title="Share node"
      description="Let others see this machine or run subshells on it. Sharing is private by default."
      isLoading={shares.isLoading}
      serverGrants={serverGrants}
      roster={roster.data ?? []}
      saving={setShares.isPending}
      onSave={(grants) => setShares.mutateAsync(grants)}
      canManage={canManage}
    />
  );
}
