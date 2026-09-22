/**
 * Reset this client — the one irreversible screen in this app.
 *
 * The shape is the server app's reset, and deliberately so: the page supplies
 * a HOSTNAME, never a path. The delete plan is read from the node's own
 * `status --json` when the screen arms and stashed on the Rust side, because
 * the chain uninstalls the very node CLI whose report names those paths; this
 * page renders the plan it is told about and can change none of it.
 *
 * Arming happens on mount rather than on the press, which is what lets an
 * un-enrolled machine say so instead of offering a button that would refuse:
 * `nodeArmReset` answers whether a plan parsed, and `false` is the not-enrolled
 * case (the CLI omits its `paths` block entirely when no config loaded).
 *
 * The disclosures below are spec 2026-09-11 § 5.4, verbatim. Each names
 * something a person would reasonably assume a reset handled, and the reason
 * they are on the confirmation rather than in a help page is that this is the
 * last moment anyone reads them.
 */
import { TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { StatusFacts } from "@/components/assistant/status-facts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionRunner } from "@/hooks/use-action-runner";
import { finished } from "@/lib/actions";
import {
  type ActionResult,
  type EnrolledNodeBody,
  type NodeSettings,
  nodeArmReset,
  nodeReset,
  type Probe,
} from "@/lib/ipc";

/** What a reset does NOT reach (spec 2026-09-11 § 5.4). */
const DISCLOSURES: readonly string[] = [
  "The control plane keeps a node row for this machine. It will show as permanently offline, and its owner has to delete it there.",
  "Any subshells that ran here are gone, and so are their pane logs.",
  "A Subshell Server on this same machine is not touched. Reset it from its own app.",
  "The installed subshell binary stays.",
  "Everything above is permanent.",
];

export function ResetScreen(props: {
  shell: FrameShell;
  /**
   * The rail node, present on the CONFIRMATION (operator ruling 2026-09-22,
   * final word on the layout: the sidebar stays) and WITHHELD while the
   * chain runs — the room is the running chain's, no navigation beside it.
   */
  rail?: ReactElement;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  runner: ActionRunner;
  busy: boolean;
  onCancel: () => void;
}) {
  const { shell, probe, settings, enrolledNode, output, runner, busy, onCancel } = props;
  /** null while arming; true once a plan is staged; false on a machine with nothing to reset. */
  const [armed, setArmed] = useState<boolean | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let live = true;
    void nodeArmReset()
      .then((ok) => {
        if (live) setArmed(ok);
      })
      // A refused arm is an un-armed screen, which renders the same refusal a
      // failed parse does: either way there is nothing staged to run.
      .catch(() => {
        if (live) setArmed(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * The name the Rust side will compare against — the same memo `node_reset`
   * reads. Shown so the box can be typed without guessing, which is the point:
   * the gate is deliberate consent, not a memory test.
   */
  const host = probe?.hostname ?? "";
  /** Where this node reports — the plane that keeps the orphaned row. */
  const reportsTo = probe?.status?.serverUrl ?? null;
  const paths = [probe?.paths?.dataDir, probe?.paths?.configFile].filter((p): p is string => Boolean(p));

  // The chain is the runner action: from the confirm press to its end the
  // screen is the room — the rail and both bar buttons hide, because no
  // navigation belongs beside a chain that is deleting this machine's node.
  const running = busy;

  return (
    <Frame
      {...shell}
      rail={running ? undefined : props.rail}
      icon={<TriangleAlert />}
      barLeft={
        running ? undefined : (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )
      }
      barRight={
        running || armed !== true ? undefined : (
          <Button
            className="min-w-[120px]"
            variant="destructive"
            disabled={busy || typed.trim() === ""}
            onClick={() => {
              if (busy || typed.trim() === "") return;
              runner.run(async () => finished(await nodeReset({ typed: typed.trim() })));
            }}
          >
            Reset Everything
          </Button>
        )
      }
    >
      {armed === false ? (
        <p className="text-muted-foreground text-sm leading-relaxed">
          This machine is not registered with a control plane, so there is nothing to reset. Nothing has been changed.
        </p>
      ) : (
        <>
          {paths.length > 0 && (
            <div>
              <p className="text-muted-foreground text-detail">This deletes</p>
              <ul className="mt-2 flex flex-col gap-1">
                {paths.map((p) => (
                  <li key={p} className="break-all font-mono text-detail">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="mt-6 flex flex-col gap-2">
            {DISCLOSURES.map((line) => (
              <li key={line} className="flex items-start gap-2 text-muted-foreground text-detail leading-relaxed">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <form
            className="mt-6 flex w-[360px] flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <Label htmlFor="reset-hostname" className="text-muted-foreground text-detail">
              {host ? (
                <>
                  Type <span className="font-mono">{host}</span> to confirm
                </>
              ) : (
                "Type this machine's name to confirm"
              )}
            </Label>
            <Input
              id="reset-hostname"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              disabled={busy || armed !== true}
            />
            {reportsTo && (
              <p className="text-muted-foreground text-detail">
                This node reports to <span className="break-all font-mono">{reportsTo}</span>.
              </p>
            )}
          </form>
        </>
      )}

      <StatusFacts probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />
    </Frame>
  );
}
