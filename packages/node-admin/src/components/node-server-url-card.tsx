import type { JSX } from "react";
import { useState } from "react";
import { useNodeService, useSetNodeServerUrl } from "../hooks/use-node-detail";
import { errMessage } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import type { NodeDetail } from "../types/node";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Which control plane this machine dials, and the one field that moves it.
 *
 * **This card belongs to the node's own loopback dashboard.** It used to sit
 * on the plane's node page too, but that surface cannot see the current
 * address (it lives in the machine's `config.json` and nothing on the wire
 * reports it), so its field could only stand blank beside a sentence
 * admitting why (removed 2026-10-09). Here the config file is in hand: the
 * current address prints below the field, and saving is an unprivileged
 * local edit, the same act as `subshell configure --server` rewriting a file
 * the machine's own user owns. It is still the widening act it always was:
 * the node will dial whatever host is typed carrying the node key it holds,
 * so the confirm dialog says so before anything is written.
 */
export function NodeServerUrlCard({ node }: { node: NodeDetail }): JSX.Element {
  const save = useSetNodeServerUrl(node.id);
  const service = useNodeService(node.id);
  const [url, setUrl] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const isOwner = node.access === "owner";
  const canSave = isOwner && url.trim().length > 0 && !save.isPending;

  async function submit(): Promise<void> {
    setFailure(null);
    setSaved(null);
    const ok = await confirmAction({
      title: "Change this node's server?",
      description: `After restarting, "${node.name}" will connect to ${url.trim()} using its existing key, so use only a server you trust. If that server doesn't recognize the node, you'll need terminal access to the node's machine to change the address back.`,
      confirmLabel: "Change server",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await save.mutateAsync({ serverUrl: url.trim() });
      setSaved(res.serverUrl);
      setUrl("");
    } catch (err) {
      setFailure(errMessage(err, "Could not change this node's address"));
    }
  }

  /** Restarting is what applies it, and it is the obvious next thing to want. */
  async function restart(): Promise<void> {
    setFailure(null);
    try {
      await service.mutateAsync({ verb: "restart" });
      setSaved(`${saved ?? ""} Restarting now.`.trim());
    } catch (err) {
      setFailure(errMessage(err, "Could not restart the node"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Control plane</CardTitle>
        <CardDescription>
          Change the server address this node connects to after its next restart. The node keeps its existing identity
          and credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor="node-server-url">New address</Label>
          <Input
            id="node-server-url"
            value={url}
            placeholder="https://subshell.example.com"
            disabled={!isOwner}
            onChange={(e) => setUrl(e.target.value)}
          />
          {/* The dashboard has the config file in hand, so the current value
              is always there to name. Absent stays silent rather than
              guessed: a missing field would be a broken view, not a blank to
              fill with an apology. */}
          {node.serverUrl && (
            <p className="text-detail text-muted-foreground">
              Current address: <span className="font-mono">{node.serverUrl}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!canSave}
            disabledReason={
              !isOwner
                ? "Only the node owner can change the server address."
                : save.isPending
                  ? "Wait for the address to save."
                  : "Enter a server address first."
            }
            onClick={() => void submit()}
          >
            Save address
          </Button>
          {saved && (
            <Button
              variant="outline"
              disabled={service.isPending}
              disabledReason={"Wait for the service action to finish."}
              onClick={() => void restart()}
            >
              Restart to apply
            </Button>
          )}
        </div>
        {saved && <p className="text-sm text-success">Saved. {saved}</p>}
        {failure && (
          <p role="alert" className="text-destructive text-detail">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
