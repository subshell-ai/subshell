import type { JSX } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNodeService, useSetNodeServerUrl } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { NodeDetail } from "@/types/node";

/**
 * Which control plane this node dials (spec 2026-09-12, node half § 5).
 *
 * **Owner only, and the card says why.** Locally this is an unprivileged edit
 * — `subshell configure --server` rewrites a 0600 file the machine's own user
 * already owns. Doing it from here is a different act: the node then dials
 * whatever host was typed carrying a credential valid on THIS plane, and the
 * machine leaves this instance. An `edit` grantee is trusted to interrupt a
 * machine they were shared; making it someone else's is not that.
 *
 * The field starts EMPTY rather than pre-filled, because the plane does not
 * know the answer: which address a node dials lives in that machine's own
 * `config.json` and is reported by nothing on the wire. Showing a guess there
 * would be inventing the current value.
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
      title: `Point "${node.name}" at ${url.trim()}?`,
      description:
        "That machine will dial the new address from its next restart, carrying the node key it holds today — so only name a control plane you trust. If the new plane does not know this node, it goes offline here and stays offline until someone with a shell on that machine points it back.",
      confirmLabel: "Repoint node",
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
          The address this machine dials. Changing it keeps the node's identity — its id, its key and the server key it
          pinned at enrollment — so this is a move, never a re-enrollment. It takes effect when the node restarts.
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
          <p className="text-detail text-muted-foreground">
            {isOwner
              ? "This server cannot see which address the node currently uses — that lives in its own config file."
              : "Only the node's owner can change this."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={!canSave} onClick={() => void submit()}>
            Save address
          </Button>
          {saved && (
            <Button variant="outline" disabled={service.isPending} onClick={() => void restart()}>
              Restart to apply
            </Button>
          )}
        </div>
        {saved && <p className="text-sm text-success">Saved. {saved}</p>}
        {failure && (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
