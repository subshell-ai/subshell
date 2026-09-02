import { useState } from "react";
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
import { useCreateSetupKey } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { errMessage } from "@/lib/api";
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
  const { data: publicSettings } = usePublicSettings();
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [baselineCount, setBaselineCount] = useState<number | null>(null);

  function close() {
    onOpenChange(false);
    setCreated(null);
    setName("");
    setFormError(null);
    setCopied(false);
    setBaselineCount(null);
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
      setName("");
    } catch (err) {
      setFormError(errMessage(err, "Something went wrong — no key was created."));
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
  // Bake the SERVER's own address (APP_BASE_URL via /settings/public), not
  // window.location.origin — the browser may reach the instance through a dev
  // proxy port or a name the remote node cannot dial (spec 2026-08-31 §9.3
  // loopback trap). The backend serves /install.sh and accepts the key as
  // ?setup_key= (downloads route); origin is the pre-load fallback.
  const baseUrl = publicSettings?.appBaseUrl ?? window.location.origin;
  const installCommand = created ? `curl -fsSL "${baseUrl}/install.sh?setup_key=${created.key}" | bash` : "";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Run this on the new machine</DialogTitle>
              <DialogDescription>
                The setup key below is shown once — copy the command now; a lost key means creating a new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <CopyCommandRow text={installCommand} />
            {isLoopbackUrl(baseUrl) && (
              <p className="text-amber-600 text-xs dark:text-amber-400">
                APP_BASE_URL points at loopback ({baseUrl}) — a remote node cannot dial this machine from itself;
                replace the host with this machine's VPN/LAN address (or set APP_BASE_URL).
              </p>
            )}
            <p className="text-destructive text-xs">
              Single-use, expires in 24 h. This is the only time the full key is shown.
            </p>
            {enrolled ? (
              <p className="text-sm text-success">Node enrolled — close this dialog to see it in the list.</p>
            ) : (
              <p className="text-muted-foreground text-sm">Waiting for enrollment — run the command on that machine.</p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <DialogHeader>
              <DialogTitle>Add a node</DialogTitle>
              <DialogDescription>Name the machine — a single-use setup key is created for it.</DialogDescription>
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
              {formError && <p className="text-destructive text-xs">{formError}</p>}
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
