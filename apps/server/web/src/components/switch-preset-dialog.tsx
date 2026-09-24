import { apiFetch, Button } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePresets } from "@/hooks/use-presets";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** The select's sentinel for "no preset" — the wire carries null instead
 *  (the same sentinel the launch form's Preset row uses). */
const NONE = "none";

/**
 * Switch preset (spec 2026-09-23 §3): point THIS row at another preset of
 * its own harness (or none) and restart it with the new one — the same POST
 * the Restart item sends, plus the `presetId` body. The selector is the
 * launch form's grammar: "None" first, then only presets the row's harness
 * could run, because changing the harness of a live subshell is out of the
 * design (it would silently become a fresh conversation in a different
 * agent). Confirming without changing anything is legal and is exactly a
 * restart — no client special case.
 *
 * The dialog owns its mutation the clone dialog owns its create, rather than
 * reaching through `useSubshellMutations`: that hook's restart carries no
 * body, and a preset-carrying twin would be a second restart implementation
 * for one caller. The server refuses every invalid preset (400) before it
 * kills anything, so a refused swap writes nothing and the row keeps working.
 */
export function SwitchPresetDialog({
  subshell,
  open,
  onOpenChange,
}: {
  /** The subshell whose preset is being swapped */
  subshell: SubshellView;
  /** Controlled open state, owned by the actions menu (clone-dialog posture) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { data: presets } = usePresets();
  const options = (presets ?? []).filter((p) => p.harnessId === subshell.harnessId);
  // Chosen wins; until then the row's preset, falling back to "none" once
  // the list has ANSWERED and cannot resolve it (a deleted preset, or one a
  // grantee swapped in — spec §3). In-flight is not "missing": the raw id
  // stays selected until the list proves otherwise.
  const [chosen, setChosen] = useState<string | null>(null);
  const selection =
    chosen ??
    (subshell.presetId === null
      ? NONE
      : presets === undefined
        ? subshell.presetId
        : options.some((p) => p.id === subshell.presetId)
          ? subshell.presetId
          : NONE);
  const swap = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>(`/api/subshells/${subshell.id}/restart`, {
        method: "POST",
        body: JSON.stringify({ presetId: selection === NONE ? null : selection }),
      }),
    onSuccess: () => {
      // Same refresh the plain restart does — revival keeps the id.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Switch preset</DialogTitle>
          <DialogDescription>The session restarts with the new preset's settings.</DialogDescription>
        </DialogHeader>
        <Select
          value={selection}
          onValueChange={(v) => v !== null && setChosen(v)}
          // Base UI's Value prints the RAW value without this map; labels
          // must match the item texts below exactly.
          items={[{ value: NONE, label: "None" }, ...options.map((p) => ({ value: p.id, label: p.name }))]}
        >
          <SelectTrigger aria-label="Preset" disabled={presets === undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {options.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {swap.error && (
          <p className="text-destructive text-sm">{(swap.error as Error).message || "Failed to switch preset"}</p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={swap.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={swap.isPending || presets === undefined} onClick={() => void swap.mutate()}>
            {swap.isPending ? "Switching…" : "Switch and restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
