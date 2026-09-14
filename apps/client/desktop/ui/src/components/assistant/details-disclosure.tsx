/**
 * "Show Details" — the facts, and the CLI's last words.
 *
 * The card page showed twelve fields permanently; a person opens this window
 * to DO something, not to read a status table, so the facts live behind a
 * disclosure now (spec 2026-09-12 § 6.4). Nothing is lost: the same
 * `probe-facts.ts` list renders here, and the same verbatim output block the
 * page used to carry at the bottom.
 *
 * `<details>` rather than state, because a disclosure that survives a re-render
 * is what someone reading an error while an action re-probes needs — React
 * leaves the element's own `open` alone.
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

export function DetailsDisclosure(props: {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  /** The CLI's own words from the last action, or null. */
  output: ActionResult | null;
}) {
  const { probe, settings, enrolledNode, output } = props;
  const facts = probeFacts({ probe, settings, enrolledNode });
  const parts: string[] = [];
  if (output?.stdout.trim()) parts.push(output.stdout.trim());
  if (output?.stderr.trim()) parts.push(output.stderr.trim());
  if (facts.length === 0 && parts.length === 0) return null;

  return (
    <details className="mt-6 w-full">
      <summary className="cursor-pointer text-muted-foreground text-detail hover:text-foreground">Show Details</summary>
      {facts.length > 0 && (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1 text-detail">
          {facts.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-muted-foreground">{f.key}</dt>
              <dd className={cn("m-0 break-all", FACT_CLASS[f.tone ?? "neutral"])}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {parts.length > 0 && (
        // The CLI's own words, VERBATIM — `apps/node/agent` owns every
        // operator-facing message and its strings are pinned by its own tests,
        // so this prints them and nothing else. (Was `output-block.tsx`.)
        <pre
          aria-live="polite"
          className={cn(
            "mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5",
            "font-mono text-detail leading-relaxed",
            output?.ok === false && "border-destructive",
          )}
        >
          {parts.join("\n\n")}
        </pre>
      )}
    </details>
  );
}
