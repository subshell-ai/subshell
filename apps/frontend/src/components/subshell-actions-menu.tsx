import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  BellOff,
  Copy,
  NotebookPen,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  TextCursorInput,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CloneSubshellDialog } from "@/components/clone-subshell-dialog";
import { SharingDialog } from "@/components/sharing-dialog";
import { NotesDialog } from "@/components/ui/notes-dialog";
import { TitleDialog } from "@/components/ui/title-dialog";
import { useProfiles } from "@/hooks/use-profiles";
import { useSubshellMutations } from "@/hooks/use-subshell-mutations";
import type { SubshellView } from "@/types/subshell";

/**
 * Everything you can do to a subshell, behind the shared overflow menu.
 *
 * Shared by the tiled cards, the list rows, and the subshell page header so
 * every presentation of the same subshells offers the same actions, asks the
 * same questions before the destructive ones, and doesn't drift as either
 * grows. The mutations themselves live in `useSubshellMutations`, which the
 * terminal's exited-state panel uses too.
 */
export function SubshellActionsMenu({
  subshell,
  disabled,
  onDeleted,
  children,
}: {
  subshell: SubshellView;
  /** Disables the trigger, e.g. while a bulk action is running over this row. */
  disabled?: boolean;
  /** Called after the subshell is deleted, e.g. to leave a now-dead detail page. */
  onDeleted?: () => void;
  /** When present: the menu opens on right-click of this subtree instead of
   * behind a ⋯ button — the sidebar's recent rows (spec 2026-09-03). */
  children?: ReactNode;
}): ReactNode {
  // ReactNode, not JSX.Element | null: the viewer's no-menu path returns the
  // caller's children verbatim (whatever element — or elements — they are).
  const [titleOpen, setTitleOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const navigate = useNavigate();
  const { data: profiles } = useProfiles();
  const { restart, remove, toggleNotify, busy } = useSubshellMutations(subshell.id, subshell, {
    onDeleted,
  });
  // Access drives which actions exist (spec 2026-08-31 §4.1): `view` can read
  // and watch only (so the menu itself is absent), `edit` interacts and manages
  // (notes, title, restart), and only the `owner` may ring the bell, clone,
  // manage sharing, or close. A viewer has nothing to do here.
  // Lifecycle shrank with the Close rename (spec 2026-09-03): no Terminate
  // (Close subsumes it) and no title-pin toggle (a rename IS the pin).
  const canEdit = subshell.access !== "view";
  const isOwner = subshell.access === "owner";
  // A subshell's profile is fixed at creation, so editing it + starting again
  // is THE recovery loop for a failed launch (bad key, bad flag…). Only
  // offered on dead subshells — a running one is past the point where the
  // profile matters until it starts again. Hidden until the name resolves,
  // since a bare id would only confuse.
  const profile = !subshell.alive ? profiles?.find((p) => p.id === subshell.profileId) : undefined;

  const items: ActionItem[] = [
    ...(canEdit
      ? [
          // The modal is also how a phone renames: below the tiling
          // breakpoint the header's second row shows the title as
          // display-only text (no room for an inline editor there).
          {
            icon: TextCursorInput,
            label: "Edit title",
            sidebar: true,
            onSelect: () => setTitleOpen(true),
          },
          {
            icon: NotebookPen,
            label: subshell.notes ? "Edit note" : "Add note",
            onSelect: () => setNotesOpen(true),
          },
          // No title-pin item (spec 2026-09-03): pane-title auto-naming is the
          // default and an explicit "Edit title" IS the pin — the rename locks
          // the name server-side, with no unlock path by design.
        ]
      : []),
    // Owner-only: the bell decides whether THIS subshell pushes to the owner's
    // devices, so it is theirs to set regardless of who else can act on it.
    ...(isOwner
      ? [
          subshell.notify
            ? { icon: BellOff, label: "Mute notifications", sidebar: true, onSelect: () => void toggleNotify() }
            : { icon: Bell, label: "Notify when done", sidebar: true, onSelect: () => void toggleNotify() },
        ]
      : []),
    // Revive is the sidebar's remaining lifecycle gesture (spec 2026-09-03
    // amendment, shrunk by the close-vocabulary design): a live subshell has
    // no stop action — Close removes it outright, which terminates first.
    ...(canEdit && !subshell.alive
      ? [
          {
            icon: RotateCcw,
            // A tracked-but-dead subshell resumes in place; a terminated one
            // can only be started afresh from the same profile and directory,
            // which is a different enough thing to say so.
            label: subshell.status === "running" ? "Restart" : "Start again",
            sidebar: true,
            onSelect: () => void restart(),
          },
        ]
      : []),
    // Owner-only, adjacent to the launch actions. Spec §2.1 said `canEdit`,
    // but a clone is guaranteed to 404 for a non-owner: the POST re-resolves
    // the SOURCE's profile under the CALLER's account and profiles are
    // strictly per-user (subshells.service rejects any non-owner's profileId),
    // so an `edit` grantee can never succeed. A clone is a FRESH launch under
    // the caller's account — unlike "Start again", which revives this row.
    ...(isOwner
      ? [
          {
            icon: Copy,
            label: "Clone…",
            sidebar: true,
            onSelect: () => setCloneOpen(true),
          },
        ]
      : []),
    ...(profile
      ? [
          {
            icon: SlidersHorizontal,
            label: `Edit profile "${profile.name}"`,
            onSelect: () => void navigate({ to: "/profiles/$id", params: { id: profile.id } }),
          },
        ]
      : []),
    ...(isOwner
      ? [
          { icon: Share2, label: "Share…", sidebar: true, onSelect: () => setShareOpen(true) },
          // "Close" is the DELETE verb's human name (spec 2026-09-03): it
          // terminates a running process first, then removes row + log.
          { icon: X, label: "Close", destructive: true, sidebar: true, onSelect: () => void remove() },
        ]
      : []),
  ];

  // A viewer gets no actions menu at all — they watch the subshell (read-only
  // terminal) and that is the whole of it. In children mode "no menu" must
  // still show the row itself, so the children pass through unwrapped.
  if (!canEdit) return children ? children : null;

  return (
    <>
      <ActionsMenu label={subshell.name} items={items} disabled={disabled || busy}>
        {children}
      </ActionsMenu>

      <TitleDialog
        key={`${subshell.id}-title`}
        subshellId={subshell.id}
        currentName={subshell.name}
        open={titleOpen}
        onOpenChange={setTitleOpen}
      />
      {/* Keyed by subshell id (suffixed — the dialogs are siblings in one
          fragment, so bare ids would collide) so each subshell gets a fresh
          note draft. */}
      <NotesDialog
        key={`${subshell.id}-notes`}
        subshellId={subshell.id}
        note={subshell.notes}
        open={notesOpen}
        onOpenChange={setNotesOpen}
      />
      {isOwner && <SharingDialog subshellId={subshell.id} open={shareOpen} onOpenChange={setShareOpen} />}
      {/* Mounted only while open, so every open starts from a blank name and a
          cleared POST error. Title/NotesDialog deliberately keep their draft
          across closes; a clone is a one-shot launch, so a stale name or error
          from a previous attempt would be a wrong prefill — remount-on-open
          gives the fresh state for free (Task 2 review). */}
      {cloneOpen && <CloneSubshellDialog source={subshell} open onOpenChange={setCloneOpen} />}
    </>
  );
}
