import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyableValue } from "@/components/service/copyable-value";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SERVER_LOG_DEFAULT_LINES, useServerLogs, useSetDebugLogging } from "@/hooks/use-server-logs";
import type { ServerDeployment, ServerLogLine } from "@/types/server-deployment";

/** Class for one line, by level. `raw` (an unparseable line) reads as ordinary text. */
function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "text-destructive";
  if (level === "warn") return "text-warning";
  if (level === "debug" || level === "trace") return "text-muted-foreground";
  return "";
}

/** `HH:MM:SS level message` (+ the structured context when a line carried any). */
function lineText(line: ServerLogLine): string {
  // `ts` is empty for a line the server could not parse (a partial write at
  // the cap), so the stamp is dropped rather than rendered as a leading gap.
  const stamp = line.ts && !Number.isNaN(Date.parse(line.ts)) ? `${new Date(line.ts).toLocaleTimeString()} ` : "";
  const data = line.data === undefined ? "" : ` ${JSON.stringify(line.data)}`;
  return `${stamp}${line.level} ${line.message}${data}`;
}

/** How near the bottom still counts as being at the bottom, in pixels. */
const STICK_SLACK_PX = 24;

/**
 * The tail of the server's own log, and the switch that decides how much it
 * says (spec 2026-09-12 § 4.3a).
 *
 * It sticks to the bottom **only if it was already there** — the console's
 * rule, and the one that lets a person scroll up to read something without
 * the next refresh yanking them away from it.
 *
 * The tail follows at one second, and Pause stops it. That pairing replaces a
 * Refresh button, which was the wrong control for a log twice over: it
 * offered to do the thing the poll already does, and it offered nothing for
 * the thing a person actually wants from a moving log, which is to make it
 * hold still. Scroll-stick alone does not cover that — it keeps the viewport
 * put, while the lines under it keep changing.
 */
export function ServerLogCard({
  view,
  enabled,
  /** The tail's cadence, in ms. A prop only so tests can drive it fast (see `useServerLogs`). */
  pollMs,
}: {
  view: ServerDeployment;
  enabled: boolean;
  pollMs?: number;
}) {
  const [paused, setPaused] = useState(false);
  const logs = useServerLogs(enabled, { paused, pollMs });
  const setDebug = useSetDebugLogging();
  const scroller = useRef<HTMLElement | null>(null);
  const stuck = useRef(true);
  const fromEnv = view.logging.source === "process env";
  const lines = logs.data?.lines;

  // Re-pin after every refetch — `lines` IS the dependency, and it is read in
  // the body so the exhaustive-deps fixer cannot decide otherwise and quietly
  // turn this into a mount-only effect.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current && lines) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll(): void {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Server log</CardTitle>
          <p className="mt-1.5 text-muted-foreground text-xs">
            last {SERVER_LOG_DEFAULT_LINES} lines · {Math.round(view.logging.capBytes / 1024)} KB cap, replaced when
            full · {paused ? "paused" : "following"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* The label changes, and `aria-pressed` is therefore ABSENT. It was
              there, and the pair announced "Resume, toggle button, pressed"
              while paused — which reads as "Resume is on", the exact inverse
              of the truth. APG treats a changing label as an ALTERNATIVE to
              `aria-pressed`, not a companion: an accessibility tree has one
              name and one state, and these two were made to disagree. The
              card's header line already says "paused"/"following". */}
          <Button variant="outline" size="sm" onClick={() => setPaused((was) => !was)}>
            {/* Sizing is the Button's own (`[&_svg]:size-4`), which beats a
                class here on specificity — so it is not set twice. */}
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </Button>
          {fromEnv ? (
            <span className="text-muted-foreground text-xs">Set by the environment (SUBSHELL_DEBUG_LOGGING).</span>
          ) : (
            <span className="flex items-center gap-2">
              <Label htmlFor="server-debug-logging">Debug logging</Label>
              {/* Named by the Label beside it, with NO `aria-label`. This
                  carried one, on the stated reason that Base UI's Switch Root
                  is a `<span role="switch">` and `htmlFor` names form controls
                  only. That is false at @base-ui/react 1.7.0 — read, not
                  assumed: `SwitchRoot` puts the caller's `id` on its hidden
                  `<input>` (so `htmlFor` associates with THAT), and
                  `useAriaLabelledBy` reflects the associated label back onto
                  the `role="switch"` element as `aria-labelledby`. Which is
                  also why the supervision dialog's label-only switch works.
                  Both together is the two-competing-names shape, harmless here
                  only because the strings happened to match. */}
              <Switch
                id="server-debug-logging"
                checked={view.logging.debug}
                disabled={setDebug.isPending}
                onCheckedChange={(checked: boolean) => setDebug.mutate(checked)}
              />
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs">
          Debug logging writes every request to the log file. It is capped at {Math.round(view.logging.capBytes / 1024)}{" "}
          KB and replaced when full.
        </p>
        {logs.error && <p className="text-destructive text-sm">The server log could not be read.</p>}
        {/* A named, FOCUSABLE scroll box. It was a bare `overflow-auto` `<pre>`,
            which a keyboard-only reader could not scroll at all — there was
            nothing to tab to. `<section>` rather than `role="region"` on the
            `<pre>` because the semantic element is the same thing said
            properly, and the scroll and focus have to live on the same
            element the overflow does. */}
        <section
          ref={scroller}
          onScroll={onScroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs the keyboard
          tabIndex={0}
          aria-label="Server log"
          className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-caption leading-relaxed"
        >
          <pre>
            {lines?.length
              ? lines.map((line, index) => (
                  // Log lines have no id and repeat verbatim; position within
                  // the fetched tail is the only stable key available.
                  // biome-ignore lint/suspicious/noArrayIndexKey: log lines carry no identity
                  <div key={index} className={levelClass(line.level)}>
                    {lineText(line)}
                  </div>
                ))
              : logs.isLoading
                ? "Loading…"
                : "Nothing logged yet."}
          </pre>
        </section>
        <p className="break-all font-mono text-muted-foreground text-xs">
          <CopyableValue value={view.paths.serverLog} label="Server log" />
        </p>
      </CardContent>
    </Card>
  );
}
