import { NODE_TARGETS } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateSetupKey, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { errMessage } from "@/lib/api";
import { tmuxInstallHint } from "@/lib/tmux-install";
import type { CreatedSetupKey } from "@/types/node";

/**
 * True when a base URL points at loopback — a remote machine running the
 * install command would dutifully dial ITSELF, not this server (spec
 * 2026-08-31 enroll-time loopback trap). Checked on the URL's host;
 * an unparseable URL is treated as not-loopback (no throw in render).
 */
function isLoopbackUrl(url: string): boolean {
  try {
    // WHATWG `URL.hostname` keeps brackets on IPv6 literals (`http://[::1]`
    // -> "[::1]"; the unbracketed form is an invalid URL), so only the
    // bracketed spelling can match.
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host.startsWith("127.") || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Two-step "Add node" flow (spec 2026-08-31 §5.1/§9): a label → a single-use
 * setup key whose plaintext is shown EXACTLY ONCE here, together with the
 * copy-ready install command to run on the new machine. While the dialog is
 * open the page polls the node list every 3 s, and the waiting hint flips to
 * "enrolled" when the machine shows up.
 */
export function AddNodeDialog({
  open,
  onOpenChange,
  nodeCount,
}: {
  /** Whether the dialog is shown (drives the parent's polling too) */
  open: boolean;
  /** Open/close from inside (Cancel/Done/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Current visible-node count — its rise over the creation-time baseline means "enrolled" */
  nodeCount: number;
}) {
  const create = useCreateSetupKey();
  // refetch-on-open: the shared query is 30 s fresh, but the warning's whole
  // job is tracking a fact the OPERATOR changes (publishing artifacts) and
  // then immediately re-checking by reopening this dialog — a stale verdict
  // here is the bug this field exists to prevent, in the other direction.
  const { data: publicSettings, isPending, isError, refetch } = usePublicSettings();
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [baselineCount, setBaselineCount] = useState<number | null>(null);
  // WHICH machine arrived, not just that one did. The parent's count answers
  // "something enrolled"; only the ids answer "this is yours", and a
  // concurrent enrollment (another operator, another key) would otherwise
  // hand this one a link to a stranger's node page. Read from the SAME query
  // the parent polls, so the two never disagree and no second request is made.
  const { data: nodeList } = useNodes();
  const [baselineIds, setBaselineIds] = useState<string[] | null>(null);

  function close() {
    onOpenChange(false);
    setCreated(null);
    setName("");
    setFormError(null);
    setCopied(false);
    setBaselineCount(null);
    setBaselineIds(null);
    // Clear the mutation too — a failed create would otherwise flash its error
    // through the fresh form on the next open (before the first submit).
    create.reset();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      setCreated(await create.mutateAsync(name.trim()));
      setBaselineCount(nodeCount);
      // A list that has not loaded yet leaves this null, which is a refusal to
      // identify the arrival rather than an empty baseline — with `[]` every
      // node already enrolled would read as "just arrived".
      setBaselineIds(nodeList?.nodes ? nodeList.nodes.map((n) => n.id) : null);
      setName("");
    } catch (err) {
      setFormError(errMessage(err, "Something went wrong. No key was created."));
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      // Clipboard blocked (non-secure context) — the text stays selectable.
    }
  }

  const enrolled = created !== null && baselineCount !== null && nodeCount > baselineCount;
  // Exactly one new id, or nothing: two machines enrolling while this dialog
  // waits makes "yours" a guess, and a guess here navigates someone to a node
  // they do not own. The generic line is still true in that case.
  const arrived = enrolled && baselineIds ? (nodeList?.nodes ?? []).filter((n) => !baselineIds.includes(n.id)) : [];
  const arrivedNode = arrived.length === 1 ? arrived[0] : undefined;
  // Bake the SERVER's own address (APP_BASE_URL via /settings/public), not
  // window.location.origin — the browser may reach the instance through a dev
  // proxy port or a name the remote node cannot dial (spec 2026-08-31 §9.3
  // loopback trap). The backend serves /install.sh and accepts the key as
  // ?setup_key= (downloads route); origin is the pre-load fallback.
  const baseUrl = publicSettings?.appBaseUrl ?? window.location.origin;
  const installCommand = created ? `curl -fsSL "${baseUrl}/install.sh?setup_key=${created.key}" | bash` : "";
  // The dialog cannot know the NEW machine's platform, so it judges the
  // one-liner by what the server can serve: a target missing from
  // nodeArtifactTargets 404s the download on that machine (the fresh
  // binary-only-install bug — an empty artifacts dir until release:node
  // runs). `undefined` = a server predating the field → stay silent.
  // A target absent from `nodeArtifactTargets` is only a PROBLEM when this
  // server will not go and get it. With a release source configured (the
  // default) the first machine of a platform to run the one-liner triggers the
  // download, so warning about "missing" binaries would be warning about a
  // cache that has not been filled yet — which is every fresh install, and
  // which fixes itself.
  const targets = publicSettings?.nodeArtifactTargets;
  const autoFetch = publicSettings?.nodeArtifactsAutoFetch ?? false;
  const missingTargets = targets && !autoFetch ? NODE_TARGETS.filter((t) => !targets.includes(t)) : [];
  const enrollCommand = created ? `subshell enroll --server "${baseUrl}" --key "${created.key}"` : "";
  // Rendered in BOTH steps: the operator should learn the one-liner cannot
  // work BEFORE minting a single-use key they would then watch it 404 and
  // have to re-mint. The paragraph only reads nodeArtifactTargets, which is
  // loaded by the time step 1 is on screen; the enroll-command row (which
  // needs the key) stays a step-2 thing.
  const missingNote = missingTargets.length > 0 && (
    <p className="text-amber-600 text-detail dark:text-amber-400">
      This server has no agent binary for: {missingTargets.join(", ")}, and it is configured not to download one. The
      install command 404s on those machines. Publish the binaries on the server (run{" "}
      <code className="font-mono">bun run release:node</code> from a checkout, or copy them from a node-vX.Y.Z GitHub
      Release into its node-artifacts dir), or install the agent another way and enroll directly.
    </p>
  );
  // Said once, quietly, and only where it is true: the first machine of a
  // platform waits for a ~80 MB download that later ones do not.
  const firstRunNote = autoFetch && targets && targets.length < NODE_TARGETS.length && (
    <p className="text-detail text-muted-foreground">
      The agent binary for a platform is downloaded from the project's release the first time a machine of that platform
      installs, so the first run on each takes a little longer.
    </p>
  );
  // Settings neither loaded nor errored ⇒ no verdict exists; say so instead
  // of silently showing the 404-bound command (undefined field on a LOADED
  // older server is a different case, and stays silent by design).
  const unknownNote = (isPending || isError) && (
    <p className="text-detail text-muted-foreground">Could not check whether this server publishes agent binaries.</p>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Run this on the new machine</DialogTitle>
              <DialogDescription>
                The setup key below is shown once. Copy the command now; a lost key means creating a new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {/* What the one-liner will do, said BEFORE it is pasted into a
                terminal on a machine the operator is standing at. Every
                clause is a clause of the rendered script (api/install-script
                .ts): the dest is `$HOME/.local/bin` unless SUBSHELL_DATA_DIR
                relocates it, the script ends at one `subshell setup`, and
                that verb's single question is "Run the agent in the
                background and start it at login?", default yes. */}
            <p className="text-detail text-muted-foreground">
              It installs the agent to <code className="font-mono">~/.local/bin</code>, enrolls this machine, and then
              asks whether to install a background service that starts it at login.
            </p>
            {/* tmux is a refusal, not a warning: `subshell setup` preflights
                it before the single-use key is spent. Saying so here is what
                keeps an operator from discovering it at the end of a 70 MB
                download — or, before the script warned, from a launch that
                failed an hour later. */}
            <p className="text-detail text-muted-foreground">
              That machine needs <span className="font-mono">tmux</span> first — setup refuses without it, and a node
              runs every subshell inside it. Install with{" "}
              <code className="font-mono">{tmuxInstallHint("darwin")?.command}</code> on macOS or{" "}
              <code className="font-mono">{tmuxInstallHint("linux")?.command}</code> on Linux.
            </p>
            <CopyCommandRow text={installCommand} />
            {missingNote && (
              <div className="space-y-2">
                {missingNote}
                <CopyCommandRow text={enrollCommand} />
              </div>
            )}
            {firstRunNote}
            {unknownNote}
            {isLoopbackUrl(baseUrl) && (
              <p className="text-amber-600 text-detail dark:text-amber-400">
                APP_BASE_URL points at loopback ({baseUrl}). A remote node cannot dial this machine from itself; replace
                the host with this machine's VPN/LAN address (or set APP_BASE_URL).
              </p>
            )}
            <p className="text-destructive text-detail">
              Single-use, expires in 24 h. This is the only time the full key is shown.
            </p>
            {enrolled ? (
              // The guidance used to end here, at the moment the operator most
              // needs the next step (spec 2026-09-15 §5.4). The node's own page
              // is where detection has run, so it is the page that says what
              // this machine can actually launch.
              arrivedNode ? (
                <p className="text-sm text-success">
                  {arrivedNode.name} enrolled.{" "}
                  <Link to="/nodes/$id" params={{ id: arrivedNode.id }} className="underline" onClick={close}>
                    Open its page
                  </Link>{" "}
                  to see what it can launch.
                </p>
              ) : (
                <p className="text-sm text-success">Node enrolled. Close this dialog to see it in the list.</p>
              )
            ) : (
              <p className="text-muted-foreground text-sm">Waiting for enrollment. Run the command on that machine.</p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <DialogHeader>
              <DialogTitle>Add a node</DialogTitle>
              <DialogDescription>Name the machine. A single-use setup key is created for it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label htmlFor="node-name">Node name</Label>
              <Input
                id="node-name"
                required
                maxLength={64}
                placeholder="e.g. mac mini"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {formError && <p className="text-destructive text-detail">{formError}</p>}
              {/* The verdict needs no key — do not make the operator mint
                  (and burn) one to discover the one-liner cannot work. */}
              {missingNote}
              {firstRunNote}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "Creating…" : "Create setup key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
