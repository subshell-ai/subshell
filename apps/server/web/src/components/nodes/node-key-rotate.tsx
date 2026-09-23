import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  confirmAction,
  errMessage,
  type RotatedNodeKey,
} from "@internal/node-admin";
// Pure, shared with every version comparison in the product
// (`@internal/subshell-protocol`), never re-implemented here — it is what the
// `tooOldForKeyCommand` check below reads.
import { semverLt } from "@internal/subshell-protocol";
import { KeyRound } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Segmented } from "@/components/ui/segmented";
import { useRotateNodeKey } from "@/hooks/use-nodes";

/**
 * Which machine you are standing at, deciding HOW the one fact gets applied.
 *
 * `cli` is first for the same reason the Add-node dialog puts Terminal first:
 * a headless box is the common case, and this is the only path that works
 * there. `client` is the honest half, not a duplicate — the Subshell Client
 * app has no field for a node key (its Enroll and Re-enroll steps take a
 * SETUP key, which registers a NEW node), and an operator hunting for a paste
 * box in the app needs that said out loud more than they need another
 * sentence about rotation.
 */
type Path = "cli" | "client";

const PATH_OPTIONS = [
  { value: "cli" as const, label: "CLI" },
  { value: "client" as const, label: "Client App" },
];

/**
 * The first node release that ships `configure --key` (the node CLI grew the
 * flag exactly so this card could name a command instead of pointing at a
 * hand-edit of the 0600 file). An older node gets the by-hand sentence —
 * saying "run this" about a flag that will come back `unknown option` would
 * be the old card's sin, just rarer.
 *
 * This is 0.15.0, the same cut that carries `unenroll` and `autostart`:
 * changesets minors do not stack onto a pending version PR, they compose into
 * it, so the flag reaches nodes in the release already on its way (the
 * sequencing rule, stated in the plan for 0.15.0: this PR merges BEFORE the
 * open version PR, whose bot run then carries the changeset).
 */
const MIN_CONFIGURE_KEY_NODE_VERSION = "0.15.0";

/**
 * The node's own bearer key: what it dials the plane with, and what Rotate
 * key replaces (spec 2026-08-31 §9).
 *
 * This used to be a bare button with a reveal fragment under it, and the
 * reveal's one guidance line named a `subshell config` command that has never
 * existed — so the honest read of the screen was "here is a secret; the place
 * it goes is fictional." The card is the fix at both ends. The header states
 * what rotation costs; the reveal ends at the one instruction that matters,
 * split by the machine you hold it on:
 *
 * - **CLI**: `subshell configure --key "…"` then `subshell service restart`,
 *   both copyable, both run on the node. The key travels INSIDE the first
 *   command because the CLI has no other way to be handed it, the same
 *   posture as a setup key on `subshell enroll` (ps-visible for a moment,
 *   this node's own credential, typed by the person who already owns the file
 *   it lands in).
 * - **Client App**: says plainly that the app takes no node key, so the
 *   search ends here instead of in the Re-enroll form — which spends a SETUP
 *   key and mints a second node row, the exact wrong act.
 *
 * A rotation still disconnects a working node until the key is applied;
 * `confirmAction` asks before that becomes true. The plaintext lives in state
 * only — never the query cache, never another render — and the reveal retires
 * on Done or on any node switch. The route's `message` survives as the API's
 * guidance for non-browser callers; the card's own panels replaced its job
 * here.
 */
export function NodeKeyRotate({
  nodeId,
  nodeName,
  agentVersion,
  canManage,
}: {
  /** Node whose key is rotated */
  nodeId: string;
  /** Node display name — the confirm prompt and the reveal card */
  nodeName: string;
  /** Node's reported version, or null when it has not reported one */
  agentVersion: string | null;
  /** Server-derived manager flag; others see the button disabled (the route 403s them anyway) */
  canManage: boolean;
}): JSX.Element {
  const rotate = useRotateNodeKey(nodeId);
  const [rotated, setRotated] = useState<RotatedNodeKey | null>(null);
  const [path, setPath] = useState<Path>("cli");

  // Navigating to another node must retire the previous node's plaintext —
  // it is a secret, and the reveal card would otherwise ride along. The
  // `nodeId` dependency is load-bearing: TanStack reuses route components
  // across param changes (see the same hazard noted in routes/presets_.$id),
  // so without it this effect runs once per mount and the old key survives
  // the switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire-on-change effect — nodeId is deliberately the trigger, not a read
  useEffect(() => {
    setRotated(null);
  }, [nodeId]);

  // The reported version decides only whether the one-line command can be
  // promised. An UNREPORTED version claims nothing in either direction: no
  // fallback sentence (the node may well be new), and the commands stay shown
  // — worse than a by-hand-only card would be withholding them entirely.
  const tooOldForKeyCommand = agentVersion !== null && semverLt(agentVersion, MIN_CONFIGURE_KEY_NODE_VERSION);

  async function rotateKey() {
    const ok = await confirmAction({
      title: `Rotate the key for "${nodeName}"?`,
      description:
        "The current key stops working immediately and a connected node is dropped. The card then ends with the commands that install the new one on the machine.",
      confirmLabel: "Rotate key",
      danger: true,
    });
    if (!ok) return;
    setPath("cli");
    try {
      setRotated(await rotate.mutateAsync());
    } catch {
      // The mutation keeps the error; it renders beside the button.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Node key</CardTitle>
        <CardDescription>
          The bearer key this machine's node dials the control plane with. Rotating it stops the old key at once and
          drops the live connection; the node reconnects only once the new key is installed on it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => void rotateKey()}
            disabled={!canManage || rotate.isPending}
            title={canManage ? undefined : "Only the node's manager can rotate its key"}
          >
            <KeyRound /> {rotate.isPending ? "Rotating…" : "Rotate key"}
          </Button>
          {rotate.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errMessage(rotate.error, "Key rotation failed.")}
            </p>
          )}
        </div>
        {rotated && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm">New key for “{nodeName}”, shown once, only here. A lost key means rotating again.</p>
            <CopyCommandRow text={rotated.nodeKey} label="new node key" />
            <Segmented
              ariaLabel="Where to install the new key"
              options={PATH_OPTIONS}
              value={path}
              onChange={setPath}
            />
            {path === "cli" ? (
              <div className="space-y-3">
                {/* The command carries the key inside it because the CLI is handed
                    secrets no other way — the same posture as a setup key on
                    `enroll`, and the quote keeps a token from becoming shell
                    syntax. Both rows are copyable; restart is required because
                    the RUNNING daemon holds the old key in memory. */}
                <CopyCommandRow text={`subshell configure --key "${rotated.nodeKey}"`} label="configure command" />
                <CopyCommandRow text="subshell service restart" label="restart command" />
                <p className="text-detail text-muted-foreground">
                  Run both on {nodeName} itself. The running daemon keeps the old key until it restarts.
                </p>
                {tooOldForKeyCommand && (
                  <p className="text-amber-600 text-detail dark:text-amber-400">
                    This one command needs node version {MIN_CONFIGURE_KEY_NODE_VERSION} or newer; {nodeName} reports v
                    {agentVersion}. On an older node, stop the service, replace the nodeKey value in
                    ~/.config/subshell/config.json with the key above, and start it again.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-detail text-muted-foreground">
                Subshell Client has no field for a node key, and its Enroll and Re-enroll steps want a setup key
                instead, which registers a new node rather than updating this one. Open a terminal on that machine and
                run the two commands from the CLI tab; the Client's Service screen can then restart the node.
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => setRotated(null)}>
              Done, hide the key
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
