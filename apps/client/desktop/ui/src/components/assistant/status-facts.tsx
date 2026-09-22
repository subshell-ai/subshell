/**
 * The facts, and the CLI's last words — INLINE (operator ruling 2026-09-22,
 * the same one the server wave carried: "show details should not be a section
 * at all"). The card page showed twelve fields permanently; a person opens
 * this window to DO something, not to read a status table, so the facts lived
 * behind a disclosure — and the rail made that a second navigation for one
 * answer, which is the defect the server ruling names. The same
 * `probe-facts.ts` list renders here, and the same verbatim output block the
 * page used to carry at the bottom, now always on the screen.
 */
import { cn } from "@/lib/cn";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
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
}) {
  const { probe, settings, enrolledNode } = props;
  const facts = probeFacts({ probe, settings, enrolledNode });
  if (facts.length === 0) return null;

  return (
    <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1 text-detail">
      {facts.map((f) => (
        <div key={f.key} className="contents">
          <dt className="text-muted-foreground">{f.key}</dt>
          <dd className={cn("m-0 break-all", FACT_CLASS[f.tone ?? "neutral"])}>{f.value}</dd>
        </div>
      ))}
    </dl>
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
