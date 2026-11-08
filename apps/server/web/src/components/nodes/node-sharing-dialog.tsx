import { Button, type NodeShare } from "@internal/node-admin";
import { ErrorBanner } from "@/components/error-banner";
import { type ShareLevels, SharingDialogCore } from "@/components/sharing-dialog-core";
import { useNodeShares, useSetNodeShares } from "@/hooks/use-node-shares";
import { useSharableUsers } from "@/hooks/use-subshell-shares";

/**
 * The node ladder: the two shared rungs plus `manage` on top (spec
 * 2026-11-07). Manage is the whole owner-management band, and the line under
 * the picker says where it stops, because "everything except…" is exactly
 * what a person granting it needs to know before they press Save.
 */
const NODE_SHARE_LEVELS: ShareLevels<NodeShare["permission"]> = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
  { value: "manage", label: "Manage" },
];

/**
 * On the control-plane host the ladder stops at the two shared rungs: a
 * `manage` grant on `local` is refused at the route, so offering it would
 * only set up a rejected save.
 */
const NODE_SHARE_LEVELS_PLAIN: ShareLevels<NodeShare["permission"]> = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
];

/**
 * Node sharing control (spec 2026-08-31 §9/§10) — the node-flavoured wrapper
 * around {@link SharingDialogCore}. The contract mirrors subshell-shares
 * (Everyone + named users at one of the offered levels, whole-set PUT), but
 * both routes are manager-band (owner or a Manage grantee, admin on `local`),
 * so `canManage` comes from the
 * caller's already-loaded `Node.canManage` (server-derived — never re-derived
 * here) and gates the controls inside the core.
 */
export function NodeSharingDialog({
  nodeId,
  kind,
  open,
  onOpenChange,
  canManage = true,
}: {
  /** Node whose grants this dialog edits ("local" included) */
  nodeId: string;
  /** Decides whether the Manage rung is on offer: the server host has none */
  kind: "agent" | "local";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False renders the grant list read-only */
  canManage?: boolean;
}) {
  const shares = useNodeShares(nodeId, open);
  const roster = useSharableUsers(open);
  const setShares = useSetNodeShares(nodeId);

  const serverGrants = (shares.data?.shares ?? []).map((s) => ({
    granteeUserId: s.granteeUserId,
    permission: s.permission,
  }));

  return (
    <SharingDialogCore
      open={open}
      onOpenChange={onOpenChange}
      levels={kind === "local" ? NODE_SHARE_LEVELS_PLAIN : NODE_SHARE_LEVELS}
      title="Share node"
      description={
        kind === "local"
          ? "Let others see the server host or run subshells on it. Sharing is private by default."
          : "Let others see this node or run subshells on it. Manage lets someone change everything about it except handing it to another account, retiring it, or moving files through it. Sharing is private by default."
      }
      isLoading={shares.isPending || roster.isPending}
      loadError={
        shares.isError || roster.isError ? (
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
      serverGrants={serverGrants}
      roster={roster.data ?? []}
      saving={setShares.isPending}
      onSave={(grants) => setShares.mutateAsync(grants)}
      canManage={canManage}
    />
  );
}
