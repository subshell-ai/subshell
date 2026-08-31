import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  BellOff,
  NotebookPen,
  Pin,
  PinOff,
  RotateCcw,
  SlidersHorizontal,
  SquareStop,
  Trash2,
} from "lucide-react";
import { type JSX, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { NotesDialog } from "@/components/ui/notes-dialog";
import { useProfiles } from "@/hooks/use-profiles";
import { useSessionMutations } from "@/hooks/use-session-mutations";
import type { SessionView } from "@/types/session";

/**
 * Everything you can do to a session, behind the shared overflow menu.
 *
 * Shared by the tiled cards, the list rows, and the session page header so
 * every presentation of the same sessions offers the same actions, asks the
 * same questions before the destructive ones, and doesn't drift as either
 * grows. The mutations themselves live in `useSessionMutations`, which the
 * terminal's exited-state panel uses too.
 */
export function SessionActionsMenu({
  session,
  disabled,
  onDeleted,
}: {
  session: SessionView;
  /** Disables the trigger, e.g. while a bulk action is running over this row. */
  disabled?: boolean;
  /** Called after the session is deleted, e.g. to leave a now-dead detail page. */
  onDeleted?: () => void;
}): JSX.Element {
  const [notesOpen, setNotesOpen] = useState(false);
  const navigate = useNavigate();
  const { data: profiles } = useProfiles();
  const { terminate, restart, remove, toggleTitleLock, toggleNotify, busy } = useSessionMutations(session.id, session, {
    onDeleted,
  });
  // A session's profile is fixed at creation, so editing it + starting again
  // is THE recovery loop for a failed launch (bad key, bad flag…). Only
  // offered on dead sessions — a running one is past the point where the
  // profile matters until it starts again. Hidden until the name resolves,
  // since a bare id would only confuse.
  const profile = !session.alive ? profiles?.find((p) => p.id === session.profileId) : undefined;

  const items: ActionItem[] = [
    {
      icon: NotebookPen,
      label: session.notes ? "Edit note" : "Add note",
      onSelect: () => setNotesOpen(true),
    },
    // Pane-title auto-naming is the default (Claude Code names the session
    // after the current task); a manual rename pins it. This flips back.
    session.nameLocked
      ? { icon: PinOff, label: "Resume auto title", onSelect: () => void toggleTitleLock() }
      : { icon: Pin, label: "Pin this title", onSelect: () => void toggleTitleLock() },
    // The desktop notification when the agent finishes its turn and goes
    // idle; off by default, so this is the opt-in as often as it is a mute.
    session.notify
      ? { icon: BellOff, label: "Mute notifications", onSelect: () => void toggleNotify() }
      : { icon: Bell, label: "Notify when done", onSelect: () => void toggleNotify() },
    session.alive
      ? { icon: SquareStop, label: "Terminate", onSelect: () => void terminate() }
      : {
          icon: RotateCcw,
          // A tracked-but-dead session resumes in place; a terminated one
          // can only be started afresh from the same profile and directory,
          // which is a different enough thing to say so.
          label: session.status === "running" ? "Restart" : "Start again",
          onSelect: () => void restart(),
        },
    ...(profile
      ? [
          {
            icon: SlidersHorizontal,
            label: `Edit profile "${profile.name}"`,
            onSelect: () => void navigate({ to: "/profiles/$id", params: { id: profile.id } }),
          },
        ]
      : []),
    { icon: Trash2, label: "Delete session", destructive: true, onSelect: () => void remove() },
  ];

  return (
    <>
      <ActionsMenu label={session.name} items={items} disabled={disabled || busy} />

      {/* Keyed by session id so each session gets a fresh note draft. */}
      <NotesDialog
        key={session.id}
        sessionId={session.id}
        note={session.notes}
        open={notesOpen}
        onOpenChange={setNotesOpen}
      />
    </>
  );
}
