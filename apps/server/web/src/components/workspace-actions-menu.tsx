import { apiFetch, confirmAction, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, QrCode, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { type JSX, type ReactNode, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { QrLinkDialog } from "@/components/qr-link-dialog";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * Everything you can do to a workspace, behind the shared overflow menu —
 * the workspace twin of `SubshellActionsMenu`. The three items lived inline
 * in `routes/workspaces.tsx` until the sidebar's recent rows needed the same
 * actions (spec 2026-09-03): one definition, two trigger surfaces.
 *
 * `children` switches from the ⋯ trigger to right-click mode; `onError`
 * routes delete failures wherever the host can show them (the page's banner;
 * the sidebar has no surface and omits it — the row simply remains).
 */
export function WorkspaceActionsMenu({
  workspace,
  children,
  onError,
}: {
  workspace: WorkspaceRow;
  /** When present: the menu opens on right-click of this subtree. */
  children?: ReactNode;
  /** Receives the user-facing message when a delete fails. */
  onError?: (message: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspaces();
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  /** The workspace's only destructive act, asked first — same question,
   * same danger styling, wherever the menu was opened from. */
  async function remove(): Promise<void> {
    const ok = await confirmAction({ title: "Delete this workspace?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      onError?.(errMessage(err, "Failed to delete workspace"));
    } finally {
      setBusy(false);
    }
  }

  const items: ActionItem[] = [
    // "Open" is deliberately unflagged for the sidebar: the row IS the link
    // (spec 2026-09-03 amendment).
    {
      label: "Open",
      icon: ExternalLink,
      onSelect: () => void navigate({ to: "/workspaces/$id", params: { id: workspace.id } }),
    },
    {
      label: "Open in new tab",
      icon: SquareArrowOutUpRight,
      sidebar: true,
      onSelect: () => window.open(`/workspaces/${workspace.id}`, "_blank", "noopener,noreferrer"),
    },
    // Beside the two "open it somewhere else" items, because that is what it
    // is — the somewhere else being a phone. `sidebar: true` so the rail's
    // right-click menu carries it too: looking up a workspace to open on
    // another device is as likely from the rail as from its card.
    { label: "QR code…", icon: QrCode, sidebar: true, onSelect: () => setQrOpen(true) },
    { label: "Delete workspace", icon: Trash2, destructive: true, sidebar: true, onSelect: () => void remove() },
  ];

  return (
    <>
      <ActionsMenu label={workspace.name} items={items} disabled={busy}>
        {children}
      </ActionsMenu>
      <QrLinkDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        title={`Open "${workspace.name}" elsewhere`}
        description="Scan to open this workspace on another device. It still asks whoever scans it to sign in."
        path={`/workspaces/${workspace.id}`}
      />
    </>
  );
}
