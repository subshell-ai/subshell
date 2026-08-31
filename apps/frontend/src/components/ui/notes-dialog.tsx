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
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { SESSIONS_QUERY_KEY } from "@/lib/query-keys";

/**
 * Notes editor for a session: a dialog with a textarea, persisted via
 * `PATCH /api/sessions/:id/notes`, refreshing the session cache on success.
 *
 * Controlled, with no trigger of its own, because the thing that opens it is
 * an item in the card's actions menu rather than a button sitting beside it.
 * Mount it keyed by session id so switching sessions gets a fresh draft.
 */
export function NotesDialog({
  sessionId,
  note,
  open,
  onOpenChange,
}: {
  sessionId: string;
  note: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(note ?? "");

  const mutation = useMutation({
    mutationFn: (notes: string | null) =>
      apiFetch<{ ok: boolean }>(`/api/sessions/${sessionId}/notes`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      }),
    onSuccess: () => {
      onOpenChange(false);
      // Refresh both the list feed/cards and any open session detail view.
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  function save() {
    mutation.mutate(text.trim() || null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{note ? "Edit note" : "Add note"}</DialogTitle>
          <DialogDescription>Keep a short operator note for this session.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What is this session working on?"
          rows={4}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
