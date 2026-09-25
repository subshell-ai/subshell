import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SETTINGS_QUERY_KEY } from "@/lib/query-keys";

/**
 * Settings → Auth: the pending-approval expiry window (spec 2026-09-24 §6,
 * Task 10b). One number, stored as `pending_approval_expiry_days`, read every
 * hour by the sweep that deletes sign-ins which waited this long without an
 * admin acting on them. This card is the settings route's only field that
 * edits it, and it PATCHes `/api/settings` like every other admin setting
 * (the Lockdown card is the precedent for a card owning its own PATCH and
 * invalidating the shared `settings` query the page reads).
 *
 * `days` is the ANSWERED number the route computes: an absent or damaged row
 * arrives here as 30, the same number the sweep will act on, so the card and
 * the sweep cannot disagree about a fresh instance. Re-sending the current
 * value is the sibling no-op: it heals a corrupt row, audits nothing.
 *
 * `maxDays` is the ceiling the PATCH route refuses beyond, taken from the
 * same read rather than mirrored here (final review, minor #2) — one
 * constant, on the side that enforces it.
 */

/** Draft text → the number to send, or null when it is not a valid one. */
export function parseDays(draft: string, maxDays: number): number | null {
  const trimmed = draft.trim();
  // Digits only: the server's rule is a whole number in 0..maxDays, and a
  // number input can still carry "", "1e3" or "-4" through a keystroke.
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days <= maxDays ? days : null;
}

export function PendingExpiryCard({ days, maxDays }: { days: number; maxDays: number }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(String(days));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The draft follows the server's answer (the terminal-history card keeps
  // its select in step the same way): after a save the invalidated refetch
  // re-seats the field, and another admin's write landing under this card
  // shows here rather than being silently overwritten on the next save.
  useEffect(() => {
    setDraft(String(days));
  }, [days]);

  const parsed = parseDays(draft, maxDays);
  const invalid = parsed === null;
  const dirty = parsed !== null && parsed !== days;

  async function save() {
    if (parsed === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ pendingApprovalExpiryDays: parsed }),
      });
      // The refetch is the confirmation (the switch idiom): the field re-
      // seats from the ANSWERED number, so what shows is what the route
      // stored, never what was typed.
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    } catch (err) {
      setError(errMessage(err, "Couldn't save the expiry window."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="pending-expiry-days" className="shrink-0">
            Pending approvals expire after
          </Label>
          <Input
            id="pending-expiry-days"
            type="number"
            inputMode="numeric"
            min={0}
            max={maxDays}
            step={1}
            className="w-20"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !invalid && dirty && !busy) void save();
            }}
            disabled={busy}
          />
          <span className="text-detail text-muted-foreground">days</span>
          <Button disabled={busy || !dirty || invalid} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-detail text-muted-foreground">
          The hourly sweep deletes pending sign-ins older than this. 0 keeps them forever.
        </p>
        {(invalid || error) && (
          <p role="alert" className="text-destructive text-detail">
            {error ?? `Enter a whole number of days from 0 to ${maxDays}.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
