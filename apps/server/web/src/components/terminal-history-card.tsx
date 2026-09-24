import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Label,
} from "@internal/node-admin";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Account → the per-USER terminal history cap (spec 2026-09-03
 * close-vocabulary design §2): how many trailing output lines a terminal
 * replays when attaching to a subshell, before switching to the live tail.
 * ONE value for every subshell this user owns, stored server-side in
 * `user_meta` (unlike the per-device text size above) — it is applied when
 * the SERVER captures the replay, so localStorage could not carry it. The
 * per-subshell dialog this replaced is gone; the instance env default
 * (`SUBSHELL_TERMINAL_REPLAY_LINES`, 100) is the fallback when unset here.
 * The endpoints are injectable so the read/write cycle is testable without
 * a live server (the notifications master switch is the precedent).
 */

/** Sentinel for "no personal preference" — the wire value is null. */
const DEFAULT = "default";

/** The stored cap → the select's draft value. */
export function storedToChoice(stored: number | null): string {
  return stored === null ? DEFAULT : String(stored);
}

/** The select's draft value → the wire value (null = instance default). */
export function choiceToWire(choice: string): number | null {
  return choice === DEFAULT ? null : Number(choice);
}

/** Whether the draft differs from the last server-reported value. */
export function isDirty(stored: number | null, choice: string): boolean {
  return storedToChoice(stored) !== choice;
}

const OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT, label: "Instance default (100 lines)" },
  { value: "25", label: "25 lines" },
  { value: "50", label: "50 lines" },
  { value: "100", label: "100 lines" },
  { value: "150", label: "150 lines" },
  { value: "200", label: "200 lines (maximum)" },
];

/** Module-level so the default prop is a STABLE reference — an inline arrow
 * would re-fire the load effect on every render (refetch loop). */
const getLinesDefault = () => apiFetch<{ lines: number | null }>("/api/settings/terminal-history").then((r) => r.lines);
const setLinesDefault = (lines: number | null) =>
  apiFetch<{ lines: number | null }>("/api/settings/terminal-history", {
    method: "PATCH",
    body: JSON.stringify({ lines }),
  }).then((r) => r.lines);

/** Props exist so tests can drive the card without a live server. */
export type TerminalHistoryCardProps = {
  /** Defaults to the real `GET /api/settings/terminal-history`. */
  getLines?: () => Promise<number | null>;
  /** Defaults to the real `PATCH /api/settings/terminal-history`. */
  setLines?: (lines: number | null) => Promise<number | null>;
};

/** Settings card for "how much scrollback my terminals replay". */
export function TerminalHistoryCard({
  getLines = getLinesDefault,
  setLines = setLinesDefault,
}: TerminalHistoryCardProps) {
  const [stored, setStored] = useState<number | null | undefined>(undefined); // undefined = loading
  const [choice, setChoice] = useState<string>(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getLines()
      .then((lines) => {
        if (!live) return;
        setStored(lines);
        setChoice(storedToChoice(lines));
      })
      // A failed read shows the default selection, never a broken control —
      // the server still applies its own default on attach either way.
      .catch(() => live && setStored(null));
    return () => {
      live = false;
    };
  }, [getLines]);

  const dirty = stored !== undefined && isDirty(stored, choice);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await setLines(choiceToWire(choice));
      setStored(saved);
    } catch (err) {
      setError(errMessage(err, "The setting could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terminal history</CardTitle>
        <CardDescription>
          How much scrollback your terminals load when they open a subshell; lower opens faster, and the live view is
          never affected. This account-wide choice applies on every device and to every subshell you own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Stacked on phone widths — a nowrap trigger beside a shrink-0 label
            overflowed the card on iOS (2026-09-04); from sm up it's the
            label-left row again, with min-w-0 so a long value truncates
            instead of escaping. */}
        <div className="grid max-w-72 gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <Label htmlFor="terminal-history-lines">Replayed lines</Label>
          <Select
            id="terminal-history-lines"
            value={choice}
            onValueChange={(v) => v !== null && setChoice(v)}
            items={OPTIONS}
            disabled={stored === undefined}
          >
            <SelectTrigger id="terminal-history-lines" className="w-full min-w-0">
              <SelectValue placeholder={stored === undefined ? "Loading…" : undefined} />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        ) : null}
        <Button onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
