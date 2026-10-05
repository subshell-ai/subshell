import { Button, errMessage, Input } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS, type SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { Check, X } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/hooks/use-nodes";
import {
  useCreateSshConnection,
  useResolveSshConnection,
  useSshDiscovery,
  useTestSshConnection,
  useUpdateSshConnection,
} from "@/hooks/use-ssh";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import {
  type SshConnectionView,
  type SshResolveView,
  type SshTestConnectionView,
  sshDestinationLabel,
} from "@/lib/ssh";
import { putSshTerminalFacts } from "@/lib/ssh-terminal-facts";

/**
 * The connection editor (spec §3: select connecting node, choose/enter alias,
 * review the resolved destination and connecting OS account, set the optional
 * absolute remote directory, test, save). One dialog for create and edit;
 * the title names the ACT and never interpolates the label, per the static
 * dialog-title ruling (2026-09-30).
 *
 * The resolution step is load-bearing UI, not a nicety: the snapshot the
 * Save button carries is ONLY ever the one `/resolve` accepted (spec §2's
 * "human-approved snapshot"), and editing node or alias after a resolve
 * invalidates it - a stale preview cannot be saved, and the button simply
 * stays inert until a fresh Resolve answers. Named refusals render
 * `SSH_ERROR_DESCRIPTIONS[code]` verbatim: the protocol package ships the
 * honest sentences, and the SPA maps refusals by EQUALITY, never by parsing
 * a sentence (the ssh-api-types convention).
 */

/** The resolve answer, tagged with the (node, alias) that produced it. */
interface Resolution {
  key: string;
  view: SshResolveView;
}

/** The key a snapshot belongs to: changing either half orphans it. */
const resolutionKey = (nodeId: string, alias: string) => `${nodeId} ${alias.trim()}`;

/** The destination of one ProxyJump hop, same display grammar as the final hop. */
function hopLabel(hop: SshConnectionSnapshotWire["proxyJumps"][number]): string {
  return `${hop.user ? `${hop.user}@` : ""}${hop.host}:${hop.port}`;
}

export function SshConnectionEditor({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create; a row = edit (name/directory are always editable; a new destination needs a fresh resolve). */
  connection: SshConnectionView | null;
}) {
  const { data: nodesData } = useNodes();
  const resolve = useResolveSshConnection();
  const test = useTestSshConnection();
  const create = useCreateSshConnection();
  const update = useUpdateSshConnection();

  const [nodeId, setNodeId] = useState(connection?.nodeId ?? "");
  const [alias, setAlias] = useState(connection?.snapshot.alias ?? "");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [remoteDir, setRemoteDir] = useState(connection?.remoteDir ?? "");
  const [testResult, setTestResult] = useState<SshTestConnectionView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const discovery = useSshDiscovery(nodeId || null);
  // A resolution survives only while its own (node, alias) pair still stands.
  const current: Resolution | null = resolution && resolution.key === resolutionKey(nodeId, alias) ? resolution : null;
  const accepted = current?.view.accepted === true ? current.view : null;
  const refusal = current?.view.accepted === false ? current.view : null;
  // In edit mode, a resolved snapshot that differs from the stored row is the
  // revision-raising edit: the copy says so before the human commits it.
  const snapshotChanged =
    accepted !== null &&
    connection !== null &&
    JSON.stringify(accepted.snapshot) !== JSON.stringify(connection.snapshot);

  const dirTrimmed = remoteDir.trim();
  const dirBad = dirTrimmed !== "" && !dirTrimmed.startsWith("/");
  // The snapshot a save carries: a fresh resolution, or, in edit mode with no
  // pending resolve, the row's stored one. A REFUSED current resolve blocks
  // saving: the human saw a refusal and must fix it before committing.
  const saveSnapshot: SshConnectionSnapshotWire | null = accepted
    ? accepted.snapshot
    : current || !connection
      ? null
      : connection.snapshot;
  const canSave = saveSnapshot !== null && displayName.trim() !== "" && !dirBad;

  function resetDownstream(): void {
    setResolution(null);
    setTestResult(null);
    setFormError(null);
  }

  async function onResolve(): Promise<void> {
    resetDownstream();
    const key = resolutionKey(nodeId, alias);
    try {
      const view = await resolve.mutateAsync({ nodeId, alias: alias.trim() });
      setResolution({ key, view });
    } catch (err) {
      setFormError(errMessage(err, "The node could not answer the resolve."));
    }
  }

  async function onTest(): Promise<void> {
    setFormError(null);
    if (!saveSnapshot) return;
    try {
      setTestResult(await test.mutateAsync({ nodeId, snapshot: saveSnapshot }));
    } catch (err) {
      setFormError(errMessage(err, "The test could not run."));
    }
  }

  async function onSave(): Promise<void> {
    setFormError(null);
    if (!saveSnapshot || !canSave) return;
    const dir = dirTrimmed === "" ? null : dirTrimmed;
    try {
      if (connection) {
        const patch: { displayName: string; remoteDir: string | null; snapshot?: SshConnectionSnapshotWire } = {
          displayName: displayName.trim(),
          remoteDir: dir,
        };
        if (snapshotChanged) patch.snapshot = saveSnapshot;
        await update.mutateAsync({ id: connection.id, patch });
      } else {
        await create.mutateAsync({
          nodeId,
          displayName: displayName.trim(),
          snapshot: saveSnapshot,
          remoteDir: dir,
        });
      }
      onOpenChange(false);
    } catch (err) {
      // Server refusals arrive as named ApiErrors; their message is the
      // human's next step, so it shows verbatim rather than as "save failed".
      setFormError(errMessage(err, "The connection could not be saved."));
    }
  }

  const eligibleNodes = (nodesData?.nodes ?? []).filter((n) => n.canLaunch);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{connection ? "Edit SSH connection" : "New SSH connection"}</DialogTitle>
          <DialogDescription>
            SSH credentials live on the connecting machine. This form records where to connect.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <Field>
            <FieldLabel htmlFor="ssh-node">Connecting node</FieldLabel>
            {/* PATCH carries no node: a connection lives on the node it was
                created with, so editing locks the selector. */}
            <Select
              disabled={connection !== null}
              value={nodeId}
              onValueChange={(v) => {
                setNodeId(String(v ?? ""));
                resetDownstream();
              }}
              items={eligibleNodes.map((n) => ({ value: n.id, label: n.name }))}
            >
              <SelectTrigger id="ssh-node">
                <SelectValue
                  placeholder={nodesData === undefined ? "Loading nodes…" : "Choose the node that will connect"}
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleNodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-detail text-muted-foreground">
              The machine that runs ssh. Its own account supplies the keys and the host trust.
            </p>
          </Field>

          <Field>
            <FieldLabel htmlFor="ssh-alias">Alias</FieldLabel>
            <Input
              id="ssh-alias"
              value={alias}
              onChange={(e) => {
                setAlias(e.target.value);
                resetDownstream();
              }}
              placeholder="staging"
            />
            {nodeId !== "" && discovery.isFetching ? (
              <p className="text-detail text-muted-foreground">Reading alias names on that node…</p>
            ) : null}
            {nodeId !== "" && discovery.data ? (
              <div className="flex flex-col gap-2">
                {discovery.data.aliases.length > 0 ? (
                  <section aria-label="Discovered aliases" className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                    {discovery.data.aliases.map((a) => (
                      <Button
                        key={a}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 font-mono text-detail"
                        onClick={() => {
                          setAlias(a);
                          resetDownstream();
                        }}
                      >
                        {a}
                      </Button>
                    ))}
                  </section>
                ) : (
                  <p className="text-detail text-muted-foreground">No aliases found on that node yet.</p>
                )}
                {discovery.data.includeCycle ? (
                  <p className="text-detail text-muted-foreground">The account's SSH config has an include cycle.</p>
                ) : null}
                {discovery.data.truncated ? (
                  <p className="text-detail text-muted-foreground">
                    Discovery hit its alias cap, so the list may be short.
                  </p>
                ) : null}
              </div>
            ) : null}
            <p className="text-detail text-muted-foreground">
              An alias from the account's ssh config, or a destination name that resolves on its own.
            </p>
          </Field>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void onResolve()}
              disabled={!nodeId || !alias.trim() || resolve.isPending}
            >
              {resolve.isPending ? "Resolving…" : "Resolve"}
            </Button>
            {accepted ? (
              <span className="flex items-center gap-1 text-detail text-success">
                <Check className="h-3.5 w-3.5" /> Resolved
              </span>
            ) : null}
          </div>

          {accepted ? (
            <section aria-label="Resolved destination" className="flex flex-col gap-1 rounded-md border p-3">
              <p className="font-mono font-strong text-label">{sshDestinationLabel(accepted.snapshot)}</p>
              <p className="text-detail text-muted-foreground">
                Alias {accepted.snapshot.alias} · connecting account {accepted.connectingAccount ?? "unknown"}
              </p>
              {accepted.snapshot.proxyJumps.length > 0 ? (
                <p className="text-detail text-muted-foreground">
                  Jump hosts: {accepted.snapshot.proxyJumps.map(hopLabel).join(" then ")}
                </p>
              ) : null}
              <p className="text-detail text-muted-foreground">
                Resolution reads the account's config on the connecting node. Trusted local config such as a Match exec
                block can run programs there.
              </p>
            </section>
          ) : null}

          {refusal ? (
            <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive p-3">
              <p className="text-destructive text-detail">{SSH_ERROR_DESCRIPTIONS[refusal.code]}</p>
              {refusal.settings.length > 0 ? (
                <p className="font-mono text-detail text-muted-foreground">
                  Blocked settings: {refusal.settings.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="ssh-name">
              Display name <RequiredMark />
            </FieldLabel>
            <Input
              id="ssh-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              placeholder="Staging"
            />
            {nameTouched && displayName.trim() === "" ? (
              <p role="alert" className={REQUIREMENT_CAPTION_CLASS}>
                The name carries the route line.
              </p>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="ssh-dir">Remote directory</FieldLabel>
            <Input
              id="ssh-dir"
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
              placeholder="/srv/app"
              className="font-mono"
            />
            {dirBad ? (
              <p role="alert" className="text-destructive text-detail">
                Must be an absolute path on the destination.
              </p>
            ) : (
              <p className="text-detail text-muted-foreground">
                A path on the destination machine, not on the connecting node. Leave empty to start in the account's
                home.
              </p>
            )}
          </Field>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void onTest()}
              disabled={!saveSnapshot || test.isPending}
            >
              {test.isPending ? "Testing…" : "Test connection"}
            </Button>
            {testResult?.passed ? (
              <span className="flex items-center gap-1 text-detail text-success">
                <Check className="h-3.5 w-3.5" /> Passed
              </span>
            ) : null}
            {testResult && !testResult.passed ? (
              <span className="flex items-center gap-1 text-destructive text-detail">
                <X className="h-3.5 w-3.5" /> {SSH_ERROR_DESCRIPTIONS[testResult.code]}
              </span>
            ) : null}
          </div>

          {connection && snapshotChanged ? (
            <p className="text-detail text-muted-foreground">
              Saving a new destination creates a new revision. Every existing grant is revoked and must be re-issued by
              a human.
            </p>
          ) : null}

          {formError ? (
            <p role="alert" className="text-destructive text-detail">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSave || create.isPending || update.isPending}
          >
            {create.isPending || update.isPending ? "Saving…" : connection ? "Save changes" : "Save connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Remember a freshly opened managed terminal so this tab can render the pane
 * with its trusted label, control state, and uploads off (the create response
 * is the only place the API answers those facts). Display material is copied
 * at open time: a later rename or delete never rewrites what the human
 * approved for THIS pane.
 */
export function rememberOpenedTerminal(
  conn: SshConnectionView,
  nodeLabel: string,
  terminal: { subshellId: string; controlOwner: "human" | "agent"; controlGeneration: number },
): void {
  putSshTerminalFacts({
    subshellId: terminal.subshellId,
    connectionId: conn.id,
    displayName: conn.displayName,
    destination: sshDestinationLabel(conn.snapshot),
    nodeId: conn.nodeId,
    nodeLabel,
    controlOwner: terminal.controlOwner,
    controlGeneration: terminal.controlGeneration,
  });
}
