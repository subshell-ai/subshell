import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Fact,
  Input,
  Label,
} from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { useNodes } from "@/hooks/use-nodes";
import {
  useApproveSshGrantRequest,
  useDenySshGrantRequest,
  useSshGrantRequests,
  useSshGrantRoster,
} from "@/hooks/use-ssh";
import { useSubshellsList } from "@/hooks/use-subshells";
import { grantSelectionError, type SshGrantRequest } from "@/lib/ssh";

/**
 * The first-use approval queue (spec 2026-10-08 §6.2): every pending question
 * the caller's key homes have asked, each card naming the asking pane, the
 * connecting machine and the destination, with the key home's live roster to
 * choose the grant's key set FROM. The selection cap is a HARD error, shown
 * red the moment the ninth key is ticked: over-cap approvals are refused by
 * the server, and the screen refuses before it, so a truncation can never be
 * mistaken for the answer that was given.
 *
 * The roster loads with the card because it is what the answer is made of:
 * an offline or refusing key home answers a named error and the request stays
 * pending, so the card shows that sentence rather than an empty picker that
 * would invite a yes against nothing. A denial needs no confirm: it writes
 * only the audit row, and a later relaunch simply asks again.
 */
export function PendingApprovals() {
  const { data: view } = useSshGrantRequests();
  const requests = (view?.requests ?? []).filter((r) => r.status === "pending");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>
          A launch that needs a key you have not granted yet asks here. An unanswered question waits 24 hours, then
          expires.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {requests.length === 0 ? (
          <p className="text-detail text-muted-foreground">Nothing is waiting for an answer.</p>
        ) : (
          <div className="space-y-6">
            {requests.map((request) => (
              <ApprovalCard key={request.id} request={request} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One pending question and the act that answers it. */
function ApprovalCard({ request }: { request: SshGrantRequest }) {
  const { data: nodeData } = useNodes();
  const { data: panes } = useSubshellsList();
  const roster = useSshGrantRoster(request.id, true);
  const approve = useApproveSshGrantRequest();
  const deny = useDenySshGrantRequest();
  const [selected, setSelected] = useState<string[]>(request.requestedFingerprints ?? []);
  const [name, setName] = useState("");

  const machineName = (id: string) =>
    (Array.isArray(nodeData?.nodes) ? nodeData.nodes : []).find((n) => n.id === id)?.name ?? id;
  const paneName = (Array.isArray(panes) ? panes : []).find((p) => p.id === request.paneId)?.name ?? request.paneId;

  const selectionError = grantSelectionError(selected);
  const toggle = (fingerprint: string) =>
    setSelected((prev) =>
      prev.includes(fingerprint) ? prev.filter((f) => f !== fingerprint) : [...prev, fingerprint],
    );

  function answerYes() {
    // The guard behind the gate (substrate contract): Enter-path submits and
    // render races land here even though the button is swept.
    if (selectionError || selected.length === 0) return;
    approve.mutate({ requestId: request.id, fingerprints: selected, name: name.trim() || undefined });
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label="Requesting pane">
          <Link to="/subshells/$id" params={{ id: request.paneId }} className="underline">
            {paneName}
          </Link>
        </Fact>
        <Fact label="Connecting machine">{machineName(request.bNodeId)}</Fact>
        <Fact label="Key home">{machineName(request.keyHomeNodeId)}</Fact>
        <Fact label="Destination" mono wide>
          {request.resolvedSelector}
        </Fact>
      </dl>
      <p className="text-detail text-muted-foreground">
        Expires {request.expiresAt.slice(0, 16).replace("T", " ")}. If this destination is trusted under an SSH
        HostKeyAlias, add its host-key pin under Destination trust first; the key home cannot capture that one itself.
      </p>
      <div>
        <Label>Choose the keys this grant may serve</Label>
        {roster.isPending && (
          <p className="mt-1 text-detail text-muted-foreground">Asking the key home&apos;s agent…</p>
        )}
        {roster.isError && (
          <p role="alert" className="mt-1 text-destructive text-detail">
            {errMessage(roster.error, "The key home could not be reached. The request stays pending.")}
          </p>
        )}
        {roster.data && roster.data.identities.length === 0 && (
          <p className="mt-1 text-detail text-muted-foreground">The key home&apos;s agent holds no keys right now.</p>
        )}
        {roster.data && roster.data.identities.length > 0 && (
          <ul className="mt-2 space-y-2">
            {roster.data.identities.map((identity) => (
              <li key={identity.fingerprint} className="flex items-start gap-3">
                <Checkbox
                  className="mt-1"
                  aria-label={identity.fingerprint}
                  checked={selected.includes(identity.fingerprint)}
                  onCheckedChange={() => toggle(identity.fingerprint)}
                />
                <div className="min-w-0">
                  <div className="break-all font-mono text-detail">{identity.fingerprint}</div>
                  {identity.comment && (
                    <div className="truncate text-detail text-muted-foreground">{identity.comment}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {selectionError && (
          <p role="alert" className="mt-2 text-destructive text-detail">
            {selectionError}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`grant-name-${request.id}`}>Grant name</Label>
        <Input
          id={`grant-name-${request.id}`}
          value={name}
          maxLength={120}
          placeholder={request.resolvedSelector}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {approve.isError && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(approve.error, "The approval could not be sent.")}
        </p>
      )}
      {deny.isError && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(deny.error, "The denial could not be sent.")}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={answerYes} disabled={!!selectionError || selected.length === 0 || approve.isPending}>
          Approve
        </Button>
        <Button variant="outline" onClick={() => deny.mutate(request.id)} disabled={deny.isPending}>
          Deny
        </Button>
      </div>
    </div>
  );
}
