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
import { SshQueryStatus } from "@/components/ssh/query-status";
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
import type { sshConnectSearch } from "@/lib/ssh-connect-search";

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
 * would invite a yes against nothing, and Approve waits for the roster to
 * arrive. A pre-selection the roster no longer carries renders as a visibly
 * DISABLED row that says why: the server validates the selection's shape, not
 * its roster membership, so this screen is the fence that keeps an invisible
 * fingerprint out of the grant. A denial needs no confirm: it writes only the
 * audit row, and a later relaunch simply asks again.
 */
export function PendingApprovals({ connection }: { connection?: ReturnType<typeof sshConnectSearch> }) {
  const [approved, setApproved] = useState<SshGrantRequest | null>(null);
  const query = useSshGrantRequests();
  const view = query.data;
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
        {approved && (
          <div role="status" className="mb-4 flex flex-col gap-2">
            <p className="text-detail">
              Keys approved for {approved.resolvedSelector}. The original connection did not start. Return to Connect
              and try again.
            </p>
            <Link
              to="/connect"
              search={
                connection?.node === approved.bNodeId && connection?.keyHome === approved.keyHomeNodeId
                  ? connection
                  : {
                      node: approved.bNodeId,
                      keyHome: approved.keyHomeNodeId,
                      destination: approved.destination ?? undefined,
                    }
              }
              className="text-label underline"
            >
              Return to Connect
            </Link>
          </div>
        )}
        {query.isPending || query.isError ? (
          <SshQueryStatus query={query} label="pending approvals" />
        ) : requests.length === 0 ? (
          <p className="text-detail text-muted-foreground">Nothing is waiting for an answer.</p>
        ) : (
          <div className="space-y-6">
            {requests.map((request) => (
              <ApprovalCard key={request.id} request={request} onApproved={() => setApproved(request)} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One pending question and the act that answers it. */
function ApprovalCard({ request, onApproved }: { request: SshGrantRequest; onApproved: () => void }) {
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

  // Once the roster has landed it is the WHOLE candidate set: a pre-selected
  // fingerprint the agent no longer holds is in no checkbox row, so the server
  // would accept it unseen (it validates shape and cap, not membership).
  // `submitted` is the intersection the approve body may carry, and `stale`
  // the part made visible as a disabled row instead.
  const rosterHeld = roster.data ? new Set(roster.data.identities.map((identity) => identity.fingerprint)) : null;
  const submitted = rosterHeld ? selected.filter((fingerprint) => rosterHeld.has(fingerprint)) : selected;
  const stale = rosterHeld ? (request.requestedFingerprints ?? []).filter((f) => !rosterHeld.has(f)) : [];

  const selectionError = grantSelectionError(submitted);
  const toggle = (fingerprint: string) =>
    setSelected((prev) =>
      prev.includes(fingerprint) ? prev.filter((f) => f !== fingerprint) : [...prev, fingerprint],
    );

  function answerYes() {
    // The guard behind the gate (substrate contract): Enter-path submits and
    // render races land here even though the button is swept.
    if (!roster.data || selectionError || submitted.length === 0) return;
    approve.mutate(
      { requestId: request.id, fingerprints: submitted, name: name.trim() || undefined },
      { onSuccess: onApproved },
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label="Requesting pane">
          {paneName === request.paneId ? (
            <span>New SSH connection (not started)</span>
          ) : (
            <Link to="/subshells/$id" params={{ id: request.paneId }} className="underline">
              {paneName}
            </Link>
          )}
        </Fact>
        <Fact label="Connecting machine">{machineName(request.bNodeId)}</Fact>
        <Fact label="SSH keys from">{machineName(request.keyHomeNodeId)}</Fact>
        <Fact label="Destination" mono wide>
          {request.destination ?? request.resolvedSelector}
        </Fact>
      </dl>
      <p className="text-detail text-muted-foreground">
        {/* Localized like the sibling house queue (pending-users-table): the deadline the operator acts before is a wall-clock moment, not a UTC stamp to mentally convert. */}
        Expires {new Date(request.expiresAt).toLocaleString()}. If this destination is trusted under an SSH
        HostKeyAlias, add its host-key pin under Destination trust first; the key home cannot capture that one itself.
      </p>
      <div>
        <Label>Choose the keys allowed for this destination</Label>
        {roster.isPending && (
          <p className="mt-1 text-detail text-muted-foreground">Asking the key home&apos;s agent…</p>
        )}
        {roster.isError && (
          <p role="alert" className="mt-1 text-destructive text-detail">
            {errMessage(roster.error, "The key home could not be reached. The request stays pending.")}
          </p>
        )}
        {roster.data && roster.data.identities.length === 0 && (
          <p className="mt-1 text-detail text-muted-foreground">
            No SSH keys are loaded on this machine. Load a key with ssh-add there, then refresh the key list.
          </p>
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
        {/* A pre-selected key the roster no longer carries: shown, disabled, and named. Its fingerprint is absent from `submitted`, so it can never be approved unseen. */}
        {roster.data && stale.length > 0 && (
          <ul className="mt-2 space-y-2">
            {stale.map((fingerprint) => (
              <li key={fingerprint} className="flex items-start gap-3">
                <Checkbox className="mt-1" aria-label={fingerprint} disabled checked={false} />
                <div className="min-w-0">
                  <div className="break-all font-mono text-detail text-muted-foreground">{fingerprint}</div>
                  <div className="text-detail text-muted-foreground">
                    {`No longer present in ${machineName(request.keyHomeNodeId)}'s agent, so it cannot be approved.`}
                  </div>
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
        <Button variant="outline" size="sm" disabled={roster.isFetching} onClick={() => void roster.refetch()}>
          Refresh keys
        </Button>
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
        {/* Approve waits for the roster: until the key home has answered there is nothing visible to answer with, and a yes made against an unrendered candidate set is the invisible approval this gate exists to prevent. */}
        <Button
          onClick={answerYes}
          disabled={!!selectionError || submitted.length === 0 || !roster.data || approve.isPending || deny.isPending}
        >
          Approve
        </Button>
        <Button
          variant="outline"
          onClick={() => deny.mutate(request.id)}
          disabled={deny.isPending || approve.isPending}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
