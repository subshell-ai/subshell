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
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";
import { SETTINGS_QUERY_KEY } from "@/lib/query-keys";

/**
 * Lockdown mode (operator ask 2026-09-24): the instance-wide emergency
 * switch, on the General page because it is an admin's decision about the
 * whole machine-fleet, and NOT gated to the Server desktop shell the way the
 * reset card is — a headless install needs the stop button too.
 *
 * NEITHER direction is a bare click (operator ruling 2026-09-24): ending a
 * lockdown is as instance-wide an act as starting one — everyone's ground
 * moves either way — so both travel through the same typed ask, and only the
 * words differ. `confirmAction` resolves a boolean and cannot carry a text
 * field (the uninstall dialog established that precedent), so this owns its
 * Dialog; its confirm button lights only when the typing equals the machine
 * name. The SERVER independently re-checks against the live node row at PATCH
 * time — that is what answers the rename-mid-dialog race, whose 400 stays
 * open beside the button that can fix it.
 *
 * The card owns its PATCH and invalidates both reads the flag drives: the
 * admin page's `settings` query (this card) and the shared public read (the
 * banner for everyone else), so no second writer knows the truth first.
 */
export function LockdownCard({ lockdown, machineName }: { lockdown: boolean; machineName: string }) {
  const queryClient = useQueryClient();
  /** Which ask is on screen, if any. Both directions route through one. */
  const [asking, setAsking] = useState<"start" | "end" | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last attempt's refusal — shown inside the dialog while it is open. */
  const [error, setError] = useState<string | null>(null);
  /** Rows the last ON could not stop — the escape the stopped-count is not. */
  const [unstopped, setUnstopped] = useState(0);

  async function flip(on: boolean, confirm: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ failed?: string[] }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ lockdown: on, lockdownConfirm: confirm }),
      });
      // No stop-count echo here (operator call 2026-09-24): the banner and the
      // suddenly-empty list are the report, and the ids belong to the audit.
      // `failed` is NOT covered by that ruling — it is the difference between
      // a full stop and a quiet escape, and the maintenance precedent (web
      // AGENTS) is that both callers surface it: dropping it tells someone a
      // machine is quiet while a pane is still alive on it.
      setUnstopped(res.failed?.length ?? 0);
      setAsking(null);
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    } catch (err) {
      setError(errMessage(err, `Couldn't ${on ? "start" : "end"} the lockdown.`));
      // A refusal ALSO refetches (review finding I-1, 2026-09-24): the dialog
      // gates on the machine-name prop, so after a rename-mid-dialog 400 the
      // page must re-read the name or the ask deadlocks — the error names the
      // NEW name, the button still demands the OLD one, and with
      // `refetchOnWindowFocus: false` nothing else would ever tell it better.
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lockdown mode</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* A button, not a switch (operator call 2026-09-24): a control that
            opens a dialog when you touch it is not reporting a state, it is
            pretending to. The card shows the state as a sentence and the ONE
            act available in it; both acts are the same ask with different
            words, so the dialog is keyed by direction, not duplicated. */}
        <div className="flex items-center justify-between gap-4">
          {lockdown ? (
            <span className="font-strong text-destructive text-label">In lockdown: no subshells can be created</span>
          ) : (
            <span className="text-detail text-muted-foreground">The instance is running normally.</span>
          )}
          {lockdown ? (
            <Button variant="outline" disabled={busy} onClick={() => setAsking("end")}>
              End lockdown
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => setAsking("start")}>
              Lock down instance
            </Button>
          )}
        </div>
        <p className="text-detail text-muted-foreground">
          Locking down stops every running subshell on every machine and blocks new ones until it ends.
        </p>
        {unstopped > 0 && (
          <p className="font-strong text-destructive text-detail" role="alert">
            {unstopped} {unstopped === 1 ? "subshell could" : "subshells could"} not be stopped. They may still be
            running.
          </p>
        )}
        {asking === null && error && <p className="text-destructive text-detail">{error}</p>}
      </CardContent>

      {asking && (
        <LockdownDialog
          mode={asking}
          machineName={machineName}
          busy={busy}
          error={error}
          onCancel={() => {
            setAsking(null);
            setError(null);
          }}
          onConfirm={(typed) => void flip(asking === "start", typed)}
        />
      )}
    </Card>
  );
}

/** Per-direction wording, one Dialog otherwise. */
const DIALOG_COPY = {
  start: {
    title: "Lock down this instance?",
    description:
      "Every subshell running on every machine stops immediately, and no new ones can be created until the lockdown ends.",
    confirm: "Lock down",
    pending: "Locking down…",
  },
  end: {
    title: "End the lockdown?",
    description: "New subshells can be created again on every machine.",
    confirm: "End lockdown",
    pending: "Ending…",
  },
} as const;

/** The typed-name ask, mount-is-open like the uninstall dialog, shared by both directions. */
function LockdownDialog({
  mode,
  machineName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  mode: "start" | "end";
  machineName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
}) {
  const copy = DIALOG_COPY[mode];
  const [typed, setTyped] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="lockdown-confirm">Type the machine name "{machineName}" to confirm.</Label>
          <Input
            id="lockdown-confirm"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // The same gate as the button, or Enter would be a way around it.
              if (e.key === "Enter" && typed.trim() === machineName && !busy) onConfirm(typed);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {/* Lights only when what was typed IS the machine name (operator
              ruling 2026-09-24): the ask is to type that name, and anything
              else has not asked yet. The SERVER's re-check against the live
              node row still runs at PATCH time, so this gates the careless
              case and the route still owns the race where the name changed
              while the dialog was open. */}
          <Button
            variant={mode === "start" ? "destructive" : "default"}
            disabled={typed.trim() !== machineName || busy}
            onClick={() => onConfirm(typed)}
          >
            {busy ? copy.pending : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
