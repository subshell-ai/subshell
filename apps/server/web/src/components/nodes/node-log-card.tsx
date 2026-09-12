import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyableValue } from "@/components/service/copyable-value";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useNodeLogSlice } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import type { NodeDetail } from "@/types/node";

/** How near the bottom still counts as being at the bottom, in pixels. */
const STICK_SLACK_PX = 24;

/** How often to ask for whatever arrived since the last read. */
const POLL_MS = 5000;

/** One JSON line of the agent's log, rendered as `HH:MM:SS level message`. */
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
 * What a node's agent logged (spec 2026-09-12, node half § 4).
 *
 * **This is the only way to read a headless node's log.** The agent's console
 * output goes wherever that platform's service manager puts it — a file under
 * launchd, the journal under systemd — so the agent writes one bounded file of
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
export function NodeLogCard({ node }: { node: NodeDetail }): JSX.Element {
  const read = useNodeLogSlice(node.id);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const offset = useRef(0);
  const scroller = useRef<HTMLPreElement | null>(null);
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
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(timer);
  }, [pull]);

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
          What the agent on this machine logged. One file, capped and replaced when full, so this is recent history
          rather than everything that ever happened.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.runtime?.agentLogPath && (
          <div className="text-xs">
            <CopyableValue value={node.runtime.agentLogPath} label="Log file" />
          </div>
        )}
        <pre
          ref={scroller}
          onScroll={onScroll}
          className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
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
        </pre>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={read.isPending} onClick={() => void pull()}>
            Refresh
          </Button>
          <span className="text-muted-foreground text-xs">refreshes every {POLL_MS / 1000}s</span>
        </div>
        {failure && (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
