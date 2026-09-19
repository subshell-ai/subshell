import { Pause, Play } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNodeLogSlice, useSetNodeLogging } from "../hooks/use-node-detail";
import { errMessage } from "../lib/api";
import type { NodeDetail } from "../types/node";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { CopyableValue } from "../ui/copyable-value";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** How near the bottom still counts as being at the bottom, in pixels. */
const STICK_SLACK_PX = 24;

/**
 * How often to ask for whatever arrived since the last read.
 *
 * One second, matching the server's own log card, so a node's log reads like
 * a tail rather than a page that updates when it feels like it. Each ask is a
 * byte RANGE — "what arrived after the offset I hold" — so a quiet log costs
 * an empty answer rather than the file.
 *
 * It is still a round trip the server's is not: this crosses the plane's
 * WebSocket to the node, where the server card reads a capped local file. The
 * two are the same number for the same reason and pay differently for it,
 * which is why this one stops in a hidden tab (see the poll effect) and the
 * server's gets that for free from TanStack.
 */
const POLL_MS = 1000;

/** One JSON line of the node's log, rendered as `HH:MM:SS level message`. */
function renderLine(line: string): { text: string; level: string } {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const ts = typeof v.timestamp === "string" && !Number.isNaN(Date.parse(v.timestamp)) ? v.timestamp : "";
    const stamp = ts ? `${new Date(ts).toLocaleTimeString()} ` : "";
    const level = typeof v.level === "string" ? v.level : "raw";
    const message = typeof v.message === "string" ? v.message : line;
    const { timestamp: _t, level: _l, message: _m, ...rest } = v;
    const data = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
    return { text: `${stamp}${level} ${message}${data}`, level };
  } catch {
    // A partial line — the file is truncated at its cap, so the last one can
    // be half-written. Shown as it is rather than dropped.
    return { text: line, level: "raw" };
  }
}

/** Class for one line, by level. `raw` reads as ordinary text. */
function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "text-destructive";
  if (level === "warn") return "text-warning";
  if (level === "debug" || level === "trace") return "text-muted-foreground";
  return "";
}

/**
 * What a node logged (spec 2026-09-12, node half § 4).
 *
 * **This is the only way to read a headless node's log.** The node's console
 * output goes wherever that platform's service manager puts it — a file under
 * launchd, the journal under systemd — so the node writes one bounded file of
 * its own, and this reads it.
 *
 * It polls by BYTE OFFSET rather than re-reading the file: each request asks
 * for what arrived since the last one. `truncated` means the file was replaced
 * at its cap and the held offset means nothing any more, so the view starts
 * over rather than sitting at a stale offset reporting an empty tail forever.
 *
 * Sticks to the bottom **only if it was already there** — the server log
 * card's rule, and what lets a person scroll up to read something without the
 * next poll yanking them away from it.
 */
export function NodeLogCard({
  node,
  /**
   * How often the tail asks, in ms. A prop only so tests can drive it fast —
   * the same reason `TrustNoticeBanner` takes `visibleMs`. Waiting a real
   * second for a real interval left its tests a 4x margin, which 34-way
   * parallel `turbo test` eats; at 20ms the same assertion has 200x.
   */
  pollMs = POLL_MS,
  local = false,
}: {
  node: NodeDetail;
  pollMs?: number;
  /** The node's own dashboard: the environment forcing debug is THIS machine's. */
  local?: boolean;
}): JSX.Element {
  const read = useNodeLogSlice(node.id);
  const setDebug = useSetNodeLogging(node.id);
  const logging = node.runtime?.logging;
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const offset = useRef(0);
  const scroller = useRef<HTMLElement | null>(null);
  const stuck = useRef(true);
  // The mutation object is new on every render, so the poll effect must not
  // depend on it — this keeps the latest call without re-arming the interval.
  const fetchRef = useRef(read.mutateAsync);
  fetchRef.current = read.mutateAsync;

  const pull = useCallback(async () => {
    try {
      const slice = await fetchRef.current({ fromByte: offset.current });
      setFailure(null);
      if (slice.truncated) {
        // The file was replaced. Start over: the offset points past the end of
        // a now-shorter file, so every later read would answer nothing.
        offset.current = 0;
        setText("");
        return;
      }
      offset.current = slice.nextByte;
      if (slice.text.length > 0) setText((prev) => prev + slice.text);
    } catch (err) {
      setFailure(errMessage(err, "Could not read this node's log"));
    }
  }, []);

  useEffect(() => {
    // Paused means the REQUESTS stop, not that a label changes over a tail
    // that is still moving — which is the failure the server log card's own
    // test asserts against by counting fetches rather than reading the button.
    if (paused) return;

    // **Nothing is asked while the tab is hidden.** This is a bare
    // `setInterval`, so unlike the server card — a TanStack query, where
    // `refetchIntervalInBackground` defaults false — it would otherwise keep
    // waking a remote node once a second behind a tab nobody is looking at,
    // for a log nobody is reading. Matching the server's cadence is only
    // defensible alongside matching the rule that comes with it.
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined) return;
      void pull();
      timer = setInterval(() => void pull(), pollMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pull, paused, pollMs]);

  // Re-pin after every poll. `text` IS the dependency, and it is READ in the
  // body so the exhaustive-deps fixer cannot decide otherwise and quietly turn
  // this into a mount-only effect — which `bun run lint` did, once, to the
  // empty array this comment replaced. `server-log-card.tsx` carries the same
  // note for the same reason.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current && text.length >= 0) el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll(): void {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
  }

  const lines = text.split("\n").filter((l) => l.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log</CardTitle>
        <CardDescription>
          {local
            ? "What this node logged. One file, capped and replaced when full, so this is recent history rather than everything that ever happened."
            : "What the node on this machine logged. One file, capped and replaced when full, so this is recent history rather than everything that ever happened."}{" "}
          · {paused ? "paused" : "following"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.runtime?.agentLogPath && (
          <div className="text-detail">
            <CopyableValue value={node.runtime.agentLogPath} label="Log file" />
          </div>
        )}
        {/* A named, FOCUSABLE scroll box — `<section>`, not a bare `<pre>`.
            An `overflow-auto` box with nothing to tab to cannot be scrolled
            without a pointer at all. Same fix, same reason, as the server's
            own log card. */}
        <section
          ref={scroller}
          onScroll={onScroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs the keyboard
          tabIndex={0}
          aria-label={`Log for ${node.name}`}
          className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5 font-mono text-detail leading-relaxed"
        >
          {lines.length === 0 ? (
            <span className="text-muted-foreground">Nothing logged yet.</span>
          ) : (
            lines.map((line, i) => {
              const { text: shown, level } = renderLine(line);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no id and are append-only
                <div key={i} className={levelClass(level)}>
                  {shown}
                </div>
              );
            })
          )}
        </section>
        <div className="flex items-center gap-3">
          {/* Pause/Resume, NOT Refresh. This polls, so a Refresh button asked
              for something already on its way and the stamp beside it said so
              twice — the pair the server's Service page deleted. What is
              missing when a view follows on its own is a way to make it STOP,
              so a person can read something without the next poll moving it.
              The label carries the state and `aria-pressed` is absent: the two
              together announce "Resume, pressed" while paused, the inverse of
              the truth. */}
          <Button variant="outline" size="sm" onClick={() => setPaused((was) => !was)}>
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </Button>
          {logging &&
            (logging.source === "process env" ? (
              <span className="text-detail text-muted-foreground">
                Debug logging is set by {local ? "this" : "that"} machine's environment (SUBSHELL_DEBUG_LOGGING).
              </span>
            ) : (
              <span className="flex items-center gap-2">
                {/* Named by the Label alone, no `aria-label` — Base UI puts the
                    caller's id on the hidden input and reflects the associated
                    label back as `aria-labelledby`. Same as the server's. */}
                <Label htmlFor="node-debug-logging">Debug logging</Label>
                <Switch
                  id="node-debug-logging"
                  checked={logging.debug}
                  disabled={setDebug.isPending}
                  onCheckedChange={(checked: boolean) => setDebug.mutate(checked)}
                />
              </span>
            ))}
        </div>
        {/* Said plainly rather than discovered by flipping it. The node has no
            debug-level call sites today — the server's switch exists for its
            HTTP request lines, and a node serves no HTTP — so this is the
            control in place ahead of the lines, not a promise of output. */}
        {logging && !logging.debug && (
          <p className="text-detail text-muted-foreground">
            The node writes no debug-level lines yet, so this changes what it would record rather than what it does.
          </p>
        )}
        {setDebug.error && (
          <p role="alert" className="text-destructive text-sm">
            {errMessage(setDebug.error, "Could not change debug logging on this node")}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
