import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/**
 * `GET /api/self/log-retention` — the window with the layer truth.
 *
 * The endpoint is LOCAL (`/api/self/…`, the Updates card's neighborhood)
 * because the plane has no counterpart route: this is the machine's own disk
 * policy, mirrored by nothing. `source` names the layer that answered each
 * field, and `forced` says the environment is the one answering, so the
 * controls can show the env variable that blocks a write instead of offering
 * a save that would only be refused.
 */
interface RetentionField {
  value: number;
  source: "env" | "stored" | "default";
  forced: boolean;
}

interface RetentionState {
  days: RetentionField;
  hours: RetentionField;
  forever: boolean;
  /**
   * Whether the daemon running here armed its hourly sweep at boot. A process
   * fact, not a window fact: a node that booted keep-forever scheduled no
   * timer, so a saved window waits for the restart that arms one, and the
   * card must not promise a sweep that is not running.
   */
  scheduled: boolean;
}

const RETENTION_KEY = ["self-log-retention"];

/** One field's layer, in the words the card prints under the input. */
function sourceLine(field: RetentionField, name: string): string {
  if (field.source === "env") return `Set by this machine's environment (${name}).`;
  if (field.source === "stored") return "Stored in config.json.";
  return "Default, unset in config.json and the environment.";
}

/** A draft input is a string until Save parses it; null means untouched. */
function parseDraft(raw: string): number | null {
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * How long pane transcripts live on THIS machine.
 *
 * The sweep itself is the agent's (`pane-log-retention.ts`: a pass at boot,
 * hourly after, a running pane's log never); this card edits the window it
 * resolves against. A save writes the node's own `config.json`, the same two
 * fields a hand-edit or the environment variables would set. WHEN the write
 * lands is the daemon's boot decision, not a property of the file: the
 * endpoint reports it as `scheduled`, with a sweep running a saved window
 * applies at the next pass without a restart (including a move back away
 * from keep-forever, which only a running pass can notice), and without one a
 * new window waits for the restart that arms it. The copy says which of those
 * two this node is rather than implying an immediate sweep or promising one
 * that never runs, and names the environment variable wherever the
 * environment is what refuses.
 */
export function LogRetentionCard(): React.ReactNode {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<string | null>(null);
  const [hours, setHours] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const state = useQuery<RetentionState>({
    queryKey: RETENTION_KEY,
    queryFn: () => apiFetch<RetentionState>("/api/self/log-retention"),
  });

  const save = useMutation({
    mutationFn: (body: { days?: number; hours?: number }) =>
      apiFetch<RetentionState>("/api/self/log-retention", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (next) => {
      setDays(null);
      setHours(null);
      setFailure(null);
      setSaved(
        next.forever
          ? "Saved. Nothing will be deleted from here on."
          : next.scheduled
            ? "Saved. The next hourly sweep uses the new window."
            : "Saved. The new window applies when the node next restarts.",
      );
      void queryClient.invalidateQueries({ queryKey: RETENTION_KEY });
    },
    onError: (err) => setFailure(errMessage(err, "The retention change was refused.")),
  });

  if (state.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        {errMessage(state.error, "Could not read this node's retention window.")}
      </p>
    );
  }
  const d = state.data;
  if (!d) return <p className="text-body text-muted-foreground">Loading…</p>;

  const draftDays = days ?? String(d.days.value);
  const draftHours = hours ?? String(d.hours.value);
  const daysTouched = days !== null && Number(days) !== d.days.value;
  const hoursTouched = hours !== null && Number(hours) !== d.hours.value;
  const parsedDays = daysTouched ? parseDraft(days as string) : null;
  const parsedHours = hoursTouched ? parseDraft(hours as string) : null;
  const invalid = (daysTouched && parsedDays === null) || (hoursTouched && parsedHours === null);
  const canSave = (daysTouched || hoursTouched) && !invalid && !save.isPending;

  function submit(): void {
    const body: { days?: number; hours?: number } = {};
    if (daysTouched && parsedDays !== null) body.days = parsedDays;
    if (hoursTouched && parsedHours !== null) body.hours = parsedHours;
    setFailure(null);
    setSaved(null);
    save.mutate(body);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pane log retention</CardTitle>
        <CardDescription>
          A pane's transcript on this machine is deleted once the pane has been gone for longer than days × 24h + hours.
          A running pane's log is never swept, and 0 days with 0 hours keeps every log forever.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Label htmlFor="retention-days">Days</Label>
            <Input
              id="retention-days"
              type="number"
              min={0}
              step={1}
              value={draftDays}
              disabled={d.days.forced}
              onChange={(e) => setDays(e.target.value)}
            />
            <p className="mt-1 text-detail text-muted-foreground">
              {sourceLine(d.days, "SUBSHELL_LOG_RETENTION_DAYS")}
            </p>
          </div>
          <div className="w-28">
            <Label htmlFor="retention-hours">Hours</Label>
            <Input
              id="retention-hours"
              type="number"
              min={0}
              step={1}
              value={draftHours}
              disabled={d.hours.forced}
              onChange={(e) => setHours(e.target.value)}
            />
            <p className="mt-1 text-detail text-muted-foreground">
              {sourceLine(d.hours, "SUBSHELL_LOG_RETENTION_HOURS")}
            </p>
          </div>
          <Button variant="outline" disabled={!canSave} onClick={submit}>
            {save.isPending ? "Saving…" : "Save window"}
          </Button>
        </div>
        {invalid && <p className="text-destructive text-detail">Each field must be a whole number of 0 or more.</p>}
        <p className="text-detail text-muted-foreground">
          {d.scheduled
            ? "The hourly sweep runs while this node is up. A saved window takes effect at the next sweep without a restart, including a move away from keep-forever."
            : d.forever
              ? "Keep-forever is in effect, so no sweep is scheduled here. A new window applies when the node next restarts."
              : "This node scheduled no sweep when it started, so nothing is being deleted on it right now. A saved window applies when the node next restarts."}
        </p>
        {saved && <p className="text-detail text-success">{saved}</p>}
        {failure && (
          <p role="alert" className="text-destructive text-detail">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
