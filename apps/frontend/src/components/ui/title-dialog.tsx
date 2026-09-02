import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { SESSION_QUERY_KEY, SESSIONS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";

/**
 * Title editor for a session: a dialog with a single-line input, persisted via
 * `PATCH /api/sessions/:id/name` (saving PINS the name against the pane-title
 * auto-sweep — "Resume auto title" in the same menu is the way back).
 *
 * Controlled, with no trigger of its own, because the thing that opens it is
 * an item in the actions menu (same posture as NotesDialog). Mount it keyed
 * by session id so switching sessions gets a fresh draft.
 */
export function TitleDialog({
  sessionId,
  currentName,
  open,
  onOpenChange,
}: {
  /** The session being renamed */
  sessionId: string;
  /** Prefilled draft AND the "unchanged" comparison baseline */
  currentName: string;
  /** Dialog open state, owned by the caller */
  open: boolean;
  /** Called on close (Cancel, backdrop, Escape) and after a successful save */
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(currentName);
  const trimmed = text.trim();
  const tooLong = trimmed.length > NAME_MAX_DEFAULT;
  const unchanged = trimmed === currentName;

  const mutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ ok: boolean }>(`/api/sessions/${sessionId}/name`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      onOpenChange(false);
      // The detail view, the list feed/cards, and the workspace pane titles
      // (which carry the session name) all re-read from these.
      void queryClient.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY, sessionId] });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });

  function save() {
    if (!unchanged && trimmed !== "" && !tooLong && !mutation.isPending) mutation.mutate(trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Edit title</DialogTitle>
          <DialogDescription>Up to {NAME_MAX_DEFAULT} characters. Saving pins the title.</DialogDescription>
        </DialogHeader>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={NAME_MAX_DEFAULT}
          aria-label="New session title"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        {tooLong && <p className="text-destructive text-xs">Keep it under {NAME_MAX_DEFAULT} characters</p>}
        {mutation.isError && (
          <p className="text-destructive text-xs">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save"}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={mutation.isPending || unchanged || trimmed === "" || tooLong}>
            {mutation.isPending ? "Saving…" : "Save title"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
