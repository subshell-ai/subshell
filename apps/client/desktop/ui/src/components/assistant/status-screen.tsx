/**
 * Status — the machine-state screen of the configured client. It evolves from
 * `connected-screen.tsx` and carried
 * the whole configured machine until the wave-3 follow-ups split it (operator
 * rulings, 2026-09-22, live screenshots): the node's machinery moved to the
 * Service section (`service-screen.tsx`) — the install offer, the service
 * verbs, the pane-safety rewrite, the node's reveals — and the plane
 * addresses moved to the Control Plane section (`plane-screen.tsx`). What
 * STAYS here is machine state: what this machine is, whether subshells can
 * run on it, what its dashboard is, and the facts that say so.
 *
 * It is NOT the landing any more (operator ruling 2026-09-22, second
 * addendum): a settled machine lands on Control Plane, which says which
 * plane the person came back to, and the rail's Status select raises this
 * screen as its own override. The rule it exists to hold is spec 2026-09-18
 * § 2, held absolutely since the door rulings (operator, 2026-09-22): this
 * screen offers NO door at all. Anything that opens the control plane, in
 * the app or in the system browser, lives on the Control Plane section's
 * Dashboard card.
 *
 * The screen offers NO act (operator rulings, 2026-09-22): Register this
 * machine joined the Service section beside the install offer (screenshot
 * 60, the node's machinery home), Re-enroll… lives on the Control Plane
 * section, and Unregister is the rail's Reset section (destructive-styled).
 * One act with two labels is two acts to a reader; so is a screen that
 * keeps machine state and offers acts.
 *
 * The probe facts and the CLI's last words render INLINE below (operator
 * ruling 2026-09-22, the server wave's ruling carried over): a section that
 * hides its own facts behind a second control is two navigations for one
 * answer.
 *
 * There is no Refresh button: the probe query re-reads this machine on its own
 * five-second interval (operator ruling 2026-09-22), so the poll is the
 * refresh.
 */
import { Bot, Server } from "lucide-react";
import type { ReactElement } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { StatusFacts } from "@/components/assistant/status-facts";
import { Badge } from "@/components/ui/badge";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { stepLabel, stepTone } from "@/lib/steps";

/** A fact's value colour per tone — the badge palette, keyed by the step's own colour. */
const TONE_BADGE: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  neutral: "muted",
};

export function StatusScreen(props: {
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  busy: boolean;
}) {
  const { shell, probe, settings, enrolledNode } = props;

  /** Whether this machine is a node at all — the axis the whole screen turns on. */
  const enrolled = Boolean(probe?.status?.nodeId);

  /**
   * The node's name, and ONLY when this session chose it: `status --json`
   * reports nodeId/serverUrl/online and no name, and `config.json`'s name is
   * not among the facts the Rust side hands out. Guessing it from the hostname
   * would be showing a default as a fact.
   */
  const named = enrolledNode?.nodeId === probe?.status?.nodeId ? enrolledNode?.name : undefined;

  return (
    <Frame
      {...shell}
      rail={props.rail}
      tightContent
      icon={enrolled ? <Bot /> : <Server />}
      // No doors on this screen (operator ruling 2026-09-22, second addendum,
      // superseding the same day's browser ghost): anything that opens the
      // control plane lives on the Control Plane section's Dashboard card.
      // The bar is empty.
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Badge variant={TONE_BADGE[stepTone(probe?.step)]}>{stepLabel(probe?.step)}</Badge>
        {/*
         * Said here only where the subtitle cannot say it. `subtitleFor`
         * already names the address in both branches, so the one sentence the
         * screen carries is the one fact the subtitle lacks: the NAME this
         * session enrolled the machine under. The not-enrolled branch says
         * NOTHING (operator ruling 2026-09-22) — the badge already says what
         * the machine is not, and a sentence that said so again was the third
         * time.
         */}
        {enrolled && named ? (
          <p className="text-sm">
            Enrolled as <span className="font-strong">{named}</span>. Subshells can run on this machine.
          </p>
        ) : null}
      </div>

      {/*
       * Register this machine is NOT here (operator ruling 2026-09-22,
       * screenshot 60): the act joined the Service section beside the install
       * offer, the node's machinery home, and the status screen keeps
       * machine state only.
       *
       * Re-enroll… is NOT here (operator ruling 2026-09-22): overwriting
       * `config.json` and minting a second node row is an act on this
       * machine's relationship to the control plane, so it lives on the
       * Control Plane section beside the plane address acts. On a machine
       * that is not a node, the act with that meaning is **Register this
       * machine** above.
       */}

      <StatusFacts probe={probe} settings={settings} enrolledNode={enrolledNode} />
    </Frame>
  );
}
