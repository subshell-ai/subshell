import { ApiError, apiFetch, Button, confirmAction, errMessage, Input } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, QrCode, SquareArrowOutUpRight, TextCursorInput, Trash2 } from "lucide-react";
import { type JSX, type ReactNode, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { QrLinkDialog } from "@/components/qr-link-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import type { WorkspaceRow } from "@/types/workspace";

/** The server normalizes workspace names at 120 characters; the field matches. */
const NAME_MAX = 120;

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
  // Renaming lives here because the page bar no longer carries the workspace's
  // name (spec 2026-10-17): the bar wears the FOCUSED PANE's subshell header,
  // and this menu — on the card and on the rail row alike — is the name's one
  // editing surface.
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  function openRename(): void {
    setNameDraft(workspace.name);
    setRenameError(null);
    setRenameOpen(true);
  }

  async function saveRename(): Promise<void> {
    const name = nameDraft.trim();
    if (!name) return;
    setSaving(true);
    setRenameError(null);
    try {
      await apiFetch(`/api/workspaces/${workspace.id}`, { method: "PUT", body: JSON.stringify({ name }) });
      await invalidate();
      setRenameOpen(false);
    } catch (err) {
      // Names stopped being unique with migration 0058; a 409 here is a stale
      // server enforcing the retired index, so say what needs updating rather
      // than blaming the name. The STATUS, never the message text: a name
      // carrying "409" would read as a collision through a substring match
      // (the lesson the deleted save dialog recorded on 2026-09-14).
      setRenameError(
        err instanceof ApiError && err.status === 409
          ? "Your server still treats workspace names as unique; update it."
          : errMessage(err, "Failed to rename workspace"),
      );
    } finally {
      setSaving(false);
    }
  }

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
    // Above Delete, below the open-somewhere-else items: it changes the row
    // you're looking at, and destructive actions keep their lonely bottom
    // shelf. `sidebar: true` is the point of the whole block — the page bar
    // stopped showing the name, so the rail's right-click is where renaming
    // lives now.
    { label: "Rename…", icon: TextCursorInput, sidebar: true, onSelect: openRename },
    { label: "Delete workspace", icon: Trash2, destructive: true, sidebar: true, onSelect: () => void remove() },
  ];

  return (
    <>
      <ActionsMenu
        label={workspace.name}
        items={items}
        disabled={busy}
        disabledReason={"Wait for the workspace action to finish."}
      >
        {children}
      </ActionsMenu>
      <QrLinkDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        title="Open this workspace on another device"
        description={`Scan to open "${workspace.name}" on another device. You'll need to sign in if you haven't already.`}
        path={`/workspaces/${workspace.id}`}
      />
      <Dialog open={renameOpen} onOpenChange={(next) => !saving && setRenameOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Names don't have to be unique; this one shows in the rail tree and on the cards.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveRename();
            }}
          >
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              maxLength={NAME_MAX}
              aria-label="Workspace name"
              autoFocus
            />
            {renameError && <p className="mt-1 text-destructive text-detail">{renameError}</p>}
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !nameDraft.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
