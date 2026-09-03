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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch, errMessage } from "@/lib/api";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/** Sentinel for "no per-subshell choice" — the wire value is null. */
const DEFAULT = "default";

const OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT, label: "Instance default (100 lines)" },
  { value: "25", label: "25 lines" },
  { value: "50", label: "50 lines" },
  { value: "100", label: "100 lines" },
  { value: "150", label: "150 lines" },
  { value: "200", label: "200 lines (maximum)" },
];

/**
 * Per-subshell terminal history cap: how many trailing output lines a terminal
 * replays when someone attaches to this subshell before switching to the live
 * tail. Long-running subshells open in milliseconds instead of re-reading
 * days of scrollback. Persisted via `PATCH /api/subshells/:id/replay`
 * (edit tier); null restores the instance default (SUBSHELL_TERMINAL_REPLAY_LINES).
 *
 * Controlled with no trigger of its own, like {@link NotesDialog} — the
 * actions-menu item opens it. Mount keyed by subshell id for a fresh draft.
 */
export function ReplayLinesDialog({
  subshellId,
  current,
  open,
  onOpenChange,
}: {
  subshellId: string;
  /** The subshell's stored cap; null = instance default. */
  current: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<string>(current === null ? DEFAULT : String(current));

  const mutation = useMutation({
    mutationFn: (lines: number | null) =>
      apiFetch<{ ok: boolean }>(`/api/subshells/${subshellId}/replay`, {
        method: "PATCH",
        body: JSON.stringify({ lines }),
      }),
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
    },
  });

  function save() {
    mutation.mutate(choice === DEFAULT ? null : Number(choice));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Terminal history</DialogTitle>
          <DialogDescription>
            How much scrollback a terminal loads when it opens this subshell. Lower opens faster; the live view is never
            affected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="subshell-replay-lines">Replayed lines</Label>
          <Select
            id="subshell-replay-lines"
            value={choice}
            onValueChange={(v) => v !== null && setChoice(v)}
            items={OPTIONS}
          >
            <SelectTrigger id="subshell-replay-lines">
              <SelectValue placeholder="Instance default (100 lines)" />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mutation.error ? (
            <p className="text-destructive text-sm">{errMessage(mutation.error, "The setting could not be saved.")}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
