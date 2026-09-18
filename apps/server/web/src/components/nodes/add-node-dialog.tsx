import { NODE_TARGETS } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateSetupKey, useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { errMessage } from "@/lib/api";
import { installAddresses } from "@/lib/install-addresses";
import type { CreatedSetupKey } from "@/types/node";

/**
 * "Add node": mint a single-use setup key (spec 2026-08-31 §5.1/§9), then hand it to
 * the machine in one of two ways.
 *
 * **It asks no name, and never did what it looked like it did.** This dialog used to
 * open with a "Node name" field whose text became only the setup key's `label`: the
 * one-liner ran `subshell setup` with no name, so the node was named by its own
 * hostname whatever was typed here. The field is gone with the 2026-09-17 revamp, and
 * the name is asked where it can actually be answered — on the machine, by `setup`, or
 * by `--name` for a script, or by the Subshell Client enroll form. What the mint does
 * now is spend a key, and the one press that does it is the whole first step.
 *
 * **Two paths, because there are two ways to arrive.** The terminal one-liner and the
 * Subshell Client app, on a `Segmented` switch under the address both of them need. The
 * command still carries the key for the terminal; the app cannot be handed a command, so
 * its half shows the two things its Enroll step asks for — the address and the key — as
 * rows of their own. The key is no longer a once-only secret either: the Setup keys card
 * on this same page lists it until it is spent or revoked, which is why closing this
 * dialog mid-copy stops being a re-mint.
 *
 * The reveal names the address the node will DIAL FOREVER, not merely the host of the
 * curl: the download address and the dial address are separate facts (a TLS proxy shows
 * the server only loopback, the `Host` header is client-written, and one instance answers
 * at several names), and only the operator's browser can see all of them. So the dialog
 * offers the same address list the mobile picker builds — the trusted-origin allowlist,
 * loopback rows dropped when anything else is known — and carries the pick to
 * `GET /install.sh` as `server=`, which bakes it ONLY if the live registry still names it
 * (`api/install-script.ts`). The paragraph that used to advise hand-editing the curl host
 * is gone (operator's call, 2026-09-18): it was advice that could not work, since
 * hand-editing never reached the baked address.
 *
 * While the dialog is open the page polls the node list every 3 s, and the waiting hint
 * flips to "enrolled" when the machine shows up.
 */

/** The two ways to put a machine on the plane. */
type Method = "terminal" | "desktop";

const METHOD_OPTIONS = [
  { value: "terminal" as const, label: "Terminal" },
  { value: "desktop" as const, label: "Desktop App" },
];

/** The `origin` of a config value, or null when it cannot be one. */
function canonicalOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The one-liner for the chosen address.
 *
 * `&server=` rides ONLY on a deliberate deviation: when the pick is the
 * canonicalized `APP_BASE_URL` the route's default already answers the chosen
 * address, and the stock command stays byte-identical to the one this dialog has
 * always rendered. When the base URL is unknown (still loading, a server predating
 * the field) nothing is compared and nothing is carried — a server old enough to
 * lack the field ignores the param anyway.
 *
 * A bracketed IPv6 row (a link-local or tailnet address the LAN probe derives)
 * additionally earns `-g`: curl reads `[fe80::1]` as a glob range and dies with
 * `(3) bad range in URL` before the server is reached, and the flag travels only
 * with the commands that contain a glob character — every other command is the same
 * bytes it has always been. With `-g` the param needs no percent-encoding, and the
 * route admits the raw bracketed spelling (pinned in the downloads-route tests).
 */
export function installCommandFor(selected: string, key: string, appBaseUrl: string | undefined): string {
  const canonical = canonicalOrigin(appBaseUrl);
  const carry = canonical !== null && selected !== canonical ? `&server=${selected}` : "";
  const glob = selected.includes("[") ? "g" : "";
  return `curl -fsSL${glob} "${selected}/install.sh?setup_key=${key}${carry}" | bash`;
}

/**
 * The air-gapped fallback: the agent got there another way, so this is the verb run
 * directly, on the machine.
 *
 * `setup` rather than `enroll` on purpose — `enroll` is the primitive that takes every
 * fact as an argument and therefore REQUIRES `--name`, which is exactly what a person
 * standing at the machine should be ASKED for instead of being made to supply to a
 * command line they are reading off a browser.
 */
export function setupCommandFor(selected: string, key: string): string {
  return `subshell setup --server "${selected}" --key "${key}"`;
}

/**
 * One sentence, two homes, ONE string (review, 2026-09-18): step 1's standalone note
 * and step 2's folded clause render this, and a shared const means the homes cannot
 * drift — "one sentence, two homes, one predicate" is true in the source now, not just
 * on screen. It belongs to the TERMINAL path alone: the desktop app ships its own agent
 * binary, so nothing is downloaded on that machine whatever this server has published.
 */
const FIRST_RUN_SENTENCE =
  "The agent binary for a platform is downloaded from the project's release the first time a machine of that " +
  "platform installs, so the first run on each takes a little longer.";

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
  const [formError, setFormError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const addressId = useId();
  // Which of the two paths the operator is being shown. Terminal first: it is
  // the one that works on a headless box, which is most of what gets added.
  const [method, setMethod] = useState<Method>("terminal");
  // The reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
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
    setFormError(null);
    setChosen(null);
    setMethod("terminal");
    setBaselineCount(null);
    setBaselineIds(null);
    // Clear the mutation too — a failed create would otherwise flash its error
    // through the fresh dialog on the next open (before the first press).
    create.reset();
  }

  async function mint() {
    setFormError(null);
    try {
      setCreated(await create.mutateAsync());
      setBaselineCount(nodeCount);
      // A list that has not loaded yet leaves this null, which is a refusal to
      // identify the arrival rather than an empty baseline — with `[]` every
      // node already enrolled would read as "just arrived".
      setBaselineIds(nodeList?.nodes ? nodeList.nodes.map((n) => n.id) : null);
    } catch (err) {
      setFormError(errMessage(err, "Something went wrong. No key was created."));
    }
  }

  const enrolled = created !== null && baselineCount !== null && nodeCount > baselineCount;
  // Exactly one new id, or nothing: two machines enrolling while this dialog
  // waits makes "yours" a guess, and a guess here navigates someone to a node
  // they do not own. The generic line is still true in that case.
  const arrived = enrolled && baselineIds ? (nodeList?.nodes ?? []).filter((n) => !baselineIds.includes(n.id)) : [];
  const arrivedNode = arrived.length === 1 ? arrived[0] : undefined;
  // The address comes from the trusted-origin allowlist (spec 2026-08-31 §9.3
  // loopback trap), the same three sources and loopback drop the mobile picker
  // uses — which is also the exact set the install.sh route will accept as
  // `server=`. Nothing is reachable ⇒ the old single row (APP_BASE_URL, origin
  // as pre-load fallback), because a command with no address is not a command.
  // It sits ABOVE the path switch because both paths need it: the terminal one
  // bakes it into the script, and the app's Connect step is typed this same URL.
  const appBaseUrl = publicSettings?.appBaseUrl;
  const baseUrl = appBaseUrl ?? window.location.origin;
  const addressRows = installAddresses({
    here: window.location.origin,
    baseUrl: appBaseUrl,
    trustedOrigins: publicSettings?.trustedOrigins,
  }).map((address) => address.url);
  const rows = addressRows.length > 0 ? addressRows : [baseUrl];
  // Dropped when no longer on offer (the settings refetch-on-open can grow
  // or shrink the list while this is open), then derived — not synced in an
  // effect, so a selection cannot survive as a stale string.
  const selected = rows.find((url) => url === chosen) ?? rows[0];
  const installCommand = created ? installCommandFor(selected, created.key, appBaseUrl) : "";
  const setupCommand = created ? setupCommandFor(selected, created.key) : "";
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
  // Rendered in BOTH steps of the TERMINAL path (and never on the desktop one):
  // the operator should learn the one-liner cannot work BEFORE minting a
  // single-use key they would then watch it 404 and have to re-mint. The
  // paragraph only reads nodeArtifactTargets, which is loaded by the time this
  // dialog is on screen; the fallback row (which needs the key) stays a
  // reveal-stage thing.
  const missingNote = missingTargets.length > 0 && (
    <p className="text-amber-600 text-detail dark:text-amber-400">
      This server has no agent binary for: {missingTargets.join(", ")}, and it is configured not to download one. The
      install command 404s on those machines. Publish the binaries on the server (run{" "}
      <code className="font-mono">bun run release:node</code> from a checkout, or copy them from a node-vX.Y.Z GitHub
      Release into that dir), or install the agent another way and run <code className="font-mono">setup</code> there —
      or add the machine with the Subshell Client app, which ships its own agent.
    </p>
  );
  // Said once, quietly — and where both homes render, the same predicate
  // decides (step 2 folds the sentence into the paragraph that explains the
  // command, 2026-09-18). The gate is `autoFetch`, which is its exact truth
  // condition: a server that fetches does delay a platform's first machine; an
  // installed-but-not-fetching one never shows this sentence even though it is
  // true there too, because that server's louder amber refusal (`missingNote`)
  // already owns the screen and telling someone to wait for a download that
  // will never come would be worse than saying nothing. In the step-2 fold the
  // leading space belongs INSIDE the fragment, so the hidden state renders no
  // trailing space after "at login."
  const showFirstRunNote = autoFetch && targets !== undefined && targets.length < NODE_TARGETS.length;
  const firstRunNote = showFirstRunNote && <p className="text-detail text-muted-foreground">{FIRST_RUN_SENTENCE}</p>;
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
              <DialogTitle>Set up the new machine</DialogTitle>
              <DialogDescription>
                It will ask what to call itself — the name is chosen there, on the machine, not here.
              </DialogDescription>
            </DialogHeader>
            {/* The dropdown, not a paragraph. Every row is an address this
                instance trusts a sign-in from — and the one chosen is what
                install.sh bakes as the node's SERVER (see the header), which
                is why picking here and picking in the mobile dialog read the
                same allowlist. A loopback-only instance gets the single row it
                always got; the script's runtime loopback guard is the note that
                fires where the fact is knowable. */}
            <div className="space-y-2">
              <Label htmlFor={addressId}>Address the node dials</Label>
              <Select value={selected} onValueChange={(url: string | null) => url && setChosen(url)}>
                <SelectTrigger id={addressId} className="w-full min-w-0">
                  <SelectValue placeholder="Choose an address" />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((url) => (
                    <SelectItem key={url} value={url}>
                      <span className="truncate">{url}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Segmented
              ariaLabel="How the machine joins"
              options={METHOD_OPTIONS}
              value={method}
              onChange={setMethod}
              className="w-full"
            />
            {method === "terminal" ? (
              <div className="space-y-3">
                {/* What the one-liner will do, said BEFORE it is pasted into a
                    terminal on a machine the operator is standing at. Every
                    clause is a clause of the rendered script
                    (api/install-script.ts): the dest is `$HOME/.local/bin`
                    unless SUBSHELL_DATA_DIR relocates it, the script ends at one
                    `subshell setup`, and that verb's two questions are the node's
                    name (default: this machine's hostname) and then "Run the agent
                    in the background and start it at login?", default yes. The
                    first-run clause is the same truth `firstRunNote` says beside
                    the mint — it belongs to the sentence it explains, so here it
                    rides INSIDE this paragraph rather than standing alone. */}
                <p className="text-detail text-muted-foreground">
                  It installs the agent to <code className="font-mono">~/.local/bin</code>, asks what to call this
                  machine, enrolls it, and then asks whether to install a background service that starts it at login.
                  {showFirstRunNote && <> {FIRST_RUN_SENTENCE}</>}
                </p>
                <CopyCommandRow text={installCommand} label="install command" />
                {missingNote && <CopyCommandRow text={setupCommand} label="setup command" />}
                {unknownNote}
              </div>
            ) : (
              <div className="space-y-3">
                {/* The app cannot be handed a command — its Enroll step takes two
                    VALUES — so this path shows exactly those two, each copyable on
                    its own. Nothing here warns about unpublished agent binaries,
                    because the app carries its own. */}
                <p className="text-detail text-muted-foreground">
                  In Subshell Client, open <strong>Window → This machine…</strong>, connect to this address, and paste
                  both on its Enroll step. The app installs the agent it ships with and asks what to call this machine.
                </p>
                {/* Label over value, the line-item shape: two rows, and the
                    button in each says out loud which of the two it copies. */}
                <div className="space-y-1">
                  <p className="font-strong text-label">Server address</p>
                  <CopyCommandRow text={selected} label="server address" />
                </div>
                <div className="space-y-1">
                  <p className="font-strong text-label">Setup key</p>
                  <CopyCommandRow text={created.key} label="setup key" />
                </div>
              </div>
            )}
            <p className="text-detail text-muted-foreground">
              Single-use, and it expires in 24 h. Until then it stays readable on the Setup keys list below, so closing
              this dialog costs nothing.
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
              <p className="text-muted-foreground text-sm">Waiting for enrollment. Run it on that machine.</p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mint();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a node</DialogTitle>
              <DialogDescription>
                This creates a single-use setup key. The machine names itself when it enrolls — nothing to fill in here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              {formError && <p className="text-destructive text-detail">{formError}</p>}
              {/* The verdict needs no key — do not make the operator mint
                  (and burn) one to discover the one-liner cannot work. The two
                  notes are about the TERMINAL path's download, so they say so. */}
              {missingNote}
              {firstRunNote}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create setup key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
