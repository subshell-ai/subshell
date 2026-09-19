import type { NodeServiceVerb } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { useNodeService } from "../hooks/use-node-detail";
import { useNodeRestartWait } from "../hooks/use-node-restart-wait";
import { errMessage } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import type { NodeDetail } from "../types/node";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

/** One button: what it does, and what a person needs to know before pressing it. */
interface VerbSpec {
  verb: NodeServiceVerb;
  label: string;
  /**
   * The confirmation's body. `kills` is whether this node's definition ends
   * panes; `here` is where the page is — the plane's browser names the node,
   * the node's own dashboard names the machine the reader is sitting at,
   * and on the dashboard "stop the node" is also "stop this page".
   */
  describe: (nodeName: string, kills: boolean, here: "remote" | "local") => string;
  /** Owner-only, because it cannot be undone from here. */
  oneWay?: boolean;
  /** Can end live panes, so it carries `force`. */
  destructive?: boolean;
}

/**
 * The five verbs, in the order a person reads them: the one they want most
 * often first, the two that cannot be undone from here last.
 */
const VERBS: VerbSpec[] = [
  {
    verb: "restart",
    label: "Restart",
    destructive: true,
    describe: (name, kills) =>
      kills
        ? `This node's service definition will close every subshell running on ${name}. Reinstall the definition on that machine to fix this, or restart anyway.`
        : "Subshells running there keep running; the node is offline for a few seconds.",
  },
  {
    verb: "start",
    label: "Start",
    describe: (name) => `Asks ${name}'s service manager to start the node from its installed definition.`,
  },
  {
    verb: "install",
    label: "Install service",
    describe: (name) =>
      `Writes a service definition on ${name} and enables it, so the node comes back on its own instead of only when someone runs it.`,
  },
  {
    verb: "stop",
    label: "Stop",
    oneWay: true,
    destructive: true,
    describe: (name, kills, here) =>
      `${kills ? `This will close every subshell running ${here === "local" ? "here" : `on ${name}`}. ` : ""}Nothing here can start it again — ${
        here === "local"
          ? "this page is served by the node, so it goes down with it; start it from a shell on this machine."
          : "that needs a shell on that machine."
      }`,
  },
  {
    verb: "uninstall",
    label: "Uninstall service",
    oneWay: true,
    destructive: true,
    describe: (name, kills, here) =>
      `${kills ? `This will close every subshell running ${here === "local" ? "here" : `on ${name}`}. ` : ""}Removes the service definition, so the node will not come back after a reboot. Nothing here can reinstall it once the node is gone — ${
        here === "local" ? "that needs a shell on this machine." : "that needs a shell on that machine."
      }`,
  },
];

/**
 * The controls that act on a node's own process (spec 2026-09-12, node half).
 *
 * **`stop` and `uninstall` say what they cost, in the confirmation.** A command
 * reaches a node over the NODE'S OWN socket, so nothing in this app can start
 * a node that is not running: those two end the connection that would have
 * carried the verb undoing them. The server gates them on ownership; this
 * names the consequence, because it is invisible from a button that looks like
 * every other one.
 *
 * Two props exist because ONE card serves two surfaces:
 *
 * - `local` — the node's OWN dashboard. The confirmations say "here" and
 *   "this machine" (there is no "that"), and the Stop copy says what the
 *   plane's reader cannot see: pressing it takes this page down with the
 *   node, because the page is served BY the node.
 * - `updateHref` — where the binary-update pointer lands. On the plane that
 *   is the fleet-wide `/settings/updates`; on the dashboard it is the node's
 *   own `/updates` page. The link is a pointer, never a second door — the
 *   card does not update the binary either way.
 *
 * The card renders nothing without a runtime report, which is also its access
 * rule — the server attaches one only for an online agent node whose viewer can
 * configure it, so there is no gate to re-derive here. (On the node's own
 * dashboard the report is always present — it is this process answering about
 * itself — so the card always renders.)
 */
export function NodeServiceCard({
  node,
  local = false,
  updateHref = "/settings/updates",
}: {
  node: NodeDetail;
  local?: boolean;
  updateHref?: string;
}): JSX.Element | null {
  const runtime = node.runtime;
  const service = useNodeService(node.id);
  const wait = useNodeRestartWait(node.id);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!runtime) return null;

  const kills = runtime.service.paneSafety !== "keeps";
  const isOwner = node.access === "owner";

  async function run(spec: VerbSpec): Promise<void> {
    if (!runtime) return;
    setFailure(null);
    setDone(null);
    const ok = await confirmAction({
      title: `${spec.label} the node "${node.name}"?`,
      description: spec.describe(node.name, kills, local ? "local" : "remote"),
      confirmLabel: spec.destructive && kills ? `${spec.label} anyway` : spec.label,
      danger: spec.destructive === true,
    });
    if (!ok) return;
    try {
      // `force` only where it means something: the server refuses it on the
      // verbs that cannot close a subshell.
      const body = spec.destructive && kills ? { verb: spec.verb, force: true } : { verb: spec.verb };
      const res = await service.mutateAsync(body);
      // Captured here, not read during the wait: the report goes away with the
      // socket the moment the node drops.
      if (spec.verb === "restart") wait.begin(runtime.startedAt);
      setDone(res.detail ?? `${spec.label} accepted.`);
    } catch (err) {
      setFailure(errMessage(err, `Could not ${spec.label.toLowerCase()} the node`));
    }
  }

  /** Why this button cannot be pressed, or undefined when it can. */
  function blocked(spec: VerbSpec): string | undefined {
    if (spec.verb === "restart" && !runtime?.supervised) {
      return `Nothing on ${local ? "this" : "that"} machine is supervising this node, so exiting would stop it rather than restart it`;
    }
    if (spec.oneWay && !isOwner) return "Only the node's owner can do this — it cannot be undone from here";
    return undefined;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service</CardTitle>
        <CardDescription>
          {local
            ? "Drive this machine's service manager. Stopping or uninstalling is one-way from here — this page is served by the node it controls, so it goes down with the node and comes back only if something else starts it."
            : "Drive the service manager on that machine. Stopping or uninstalling is one-way from here: nothing in this app can start a node that is not running, because every command travels over the node's own connection."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {VERBS.map((spec) => {
            const why = blocked(spec);
            return (
              <Button
                key={spec.verb}
                variant="outline"
                disabled={why !== undefined || service.isPending || wait.waiting}
                title={why}
                onClick={() => void run(spec)}
              >
                {spec.label}
              </Button>
            );
          })}
        </div>
        {wait.outcome === "waiting" && (
          <p className="flex items-center gap-2 text-sm text-warning">
            {/* The node drops its socket and comes back; that is tens of
                seconds during which the card would otherwise sit still and
                read as a page that had ignored the press. */}
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            <span>Restarting… waiting for {node.name} to come back.</span>
          </p>
        )}
        {wait.outcome === "timeout" && (
          <p className="text-destructive text-sm">The node has not come back. Check the node on that machine.</p>
        )}
        {/* Updating the node BINARY is a different act from driving its
            service manager, and it lives in one place for the whole fleet
            rather than being a sixth button here — a person updating nodes is
            usually updating several, and the page that lists them can say
            which ones need it. This is the pointer, not a second door. */}
        <p className="text-detail text-muted-foreground">
          To install a newer node CLI on this machine, use{" "}
          <Link to={updateHref} className="underline underline-offset-2">
            {local ? "the Updates page" : "Settings → Updates"}
          </Link>
          .
        </p>
        {done && <p className="whitespace-pre-wrap text-muted-foreground text-sm">{done}</p>}
        {failure && (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
