/**
 * What this machine currently is: one word, a refresh, and the facts.
 *
 * Everything here is a pure function of the last `node_probe` /
 * `node_settings`; {@link probeFacts} does the reading and this file does the
 * layout.
 */
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { probeFacts } from "@/lib/probe-facts";
import { stepLabel, stepTone, type Tone } from "@/lib/steps";

/** The dot's colour per tone. Neutral is the muted grey of "nothing to report". */
const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground",
};

/** A fact's value colour per tone. */
const FACT_CLASS: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "",
};

export function StatusCard(props: {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  busy: boolean;
  firstProbePending: boolean;
  onRefresh: () => void;
}) {
  const { probe, settings, enrolledNode, busy, firstProbePending, onRefresh } = props;
  const facts = probeFacts({ probe, settings, enrolledNode });
  const label = busy ? "Working…" : firstProbePending ? "Checking…" : stepLabel(probe?.step);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline" className="gap-2 py-1 font-normal text-xs">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[stepTone(probe?.step)])} />
            <span>{label}</span>
          </Badge>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </div>

        {facts.length > 0 && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1 text-xs">
            {facts.map((f) => (
              <div key={f.key} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-muted-foreground">{f.key}</dt>
                <dd className={cn("m-0 break-all", FACT_CLASS[f.tone ?? "neutral"])}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
