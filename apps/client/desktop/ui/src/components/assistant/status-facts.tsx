/**
 * The facts, and the CLI's last words — INLINE (operator ruling 2026-09-22,
 * the same one the server wave carried: "show details should not be a section
 * at all"). The card page showed twelve fields permanently; a person opens
 * this window to DO something, not to read a status table, so the facts lived
 * behind a disclosure — and the rail made that a second navigation for one
 * answer, which is the defect the server ruling names. The same
 * `probe-facts.ts` list renders here, and the same verbatim output block the
 * page used to carry at the bottom, now always on the screen.
 *
 * Path rows carry an inline **Reveal** (rails addendum, 2026-09-22, the
 * server's facts pattern): the affordance moved from the Service section's
 * bottom bar onto the row whose fact it opens. It names an INTENT, never a
 * path — the Rust side re-reads the path from its own fresh probe, so a row
 * can only reveal the fact it is showing.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import type { ActionResult, EnrolledNodeBody, LogTail, NodeSettings, OpenTarget, Probe } from "@/lib/ipc";
import { probeFacts } from "@/lib/probe-facts";
import type { Tone } from "@/lib/steps";

/** A fact's value colour per tone. */
const FACT_CLASS: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "",
};

/**
 * The facts list, and ONLY the facts list — Status's alone (operator ruling
 * 2026-09-22, screenshot 60: "that data should only be in the status panel").
 * Every other screen lost it; a screen that needs a fact to explain a state
 * says it in its own card's sentence. The CLI's last words are
 * {@link ActionOutput}, a separate piece a screen renders when the action is
 * its own.
 */
export function StatusFacts(props: {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  /** Reveal one of the closed targets. Opens the fact the row is showing. */
  onReveal: (target: OpenTarget) => void;
}) {
  const { probe, settings, enrolledNode, onReveal } = props;
  const facts = probeFacts({ probe, settings, enrolledNode });
  if (facts.length === 0) return null;

  return (
    <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1 text-detail">
      {facts.map((f) => (
        <div key={f.key} className="contents">
          <dt className="text-muted-foreground">{f.key}</dt>
          <dd className={cn("m-0 break-all", FACT_CLASS[f.tone ?? "neutral"])}>
            {f.value}
            {f.reveal && (
              <button
                type="button"
                className={cn(
                  "ml-2 rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground",
                  "hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                )}
                onClick={() => onReveal(f.reveal as OpenTarget)}
              >
                Reveal
              </button>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The node's own log, last lines first kept last — the server console's
 * TailPane rule: a person who scrolled up to read would otherwise be yanked
 * out from under their own place every poll, and this re-renders on every
 * tick while the Status section is up. The stick is therefore unconditional
 * on ticks and measured at the pane, not at the data.
 */
export function NodeLogPane(props: { tail: LogTail | null }): ReactNode {
  const ref = useRef<HTMLPreElement | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    // No deps array: the stick is load-bearing on every tick while the
    // section is up — re-applying the same scrollTop is a no-op, and missing
    // a tick is a pane that stops following the log.
    const box = ref.current;
    if (box === null) return;
    if (atBottom.current) box.scrollTop = box.scrollHeight;
  });
  const text = props.tail?.text ?? "";
  return (
    <>
      <p className="mt-6 font-strong text-label">Node log</p>
      {/* Where these lines come from — the file's own path, Rust's answer,
          never one the page repeated. */}
      {props.tail?.source && <p className="mt-1 break-all text-detail text-muted-foreground">{props.tail.source}</p>}
      <pre
        ref={ref}
        onScroll={(e) => {
          const box = e.currentTarget;
          atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        }}
        className={cn(
          "mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5",
          "font-mono text-detail leading-relaxed",
          text === "" && "text-muted-foreground",
        )}
      >
        {props.tail === null ? "" : text || (props.tail.note ?? "")}
      </pre>
    </>
  );
}

/**
 * The CLI's own words from the LAST action, VERBATIM — `apps/node/agent` owns
 * every operator-facing message and its strings are pinned by its own tests,
 * so this prints them and nothing else. (Was the bottom half of this file's
 * single component.) A screen renders it when the action is ITS own; the App
 * gates the words to the screen the action was pressed on (operator ruling
 * 2026-09-22), and opens and instantaneous saves record nothing at all.
 */
export function ActionOutput(props: { output: ActionResult | null }) {
  const parts: string[] = [];
  if (props.output?.stdout.trim()) parts.push(props.output.stdout.trim());
  if (props.output?.stderr.trim()) parts.push(props.output.stderr.trim());
  if (parts.length === 0) return null;
  return (
    <pre
      aria-live="polite"
      className={cn(
        "mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5",
        "font-mono text-detail leading-relaxed",
        props.output?.ok === false && "border-destructive",
      )}
    >
      {parts.join("\n\n")}
    </pre>
  );
}
