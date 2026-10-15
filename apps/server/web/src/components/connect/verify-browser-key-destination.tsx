import { confirmAction } from "@internal/node-admin";
import type { LocalKeyPreparation } from "@/lib/ssh-local-key";

/** Approval precedes reading the selected private file or sending any authentication signature. */
export async function verifyBrowserKeyDestination(
  target: LocalKeyPreparation,
  selection: { keyFileName: string; nodeName: string },
): Promise<boolean> {
  const bytes = Uint8Array.from(atob(target.hostKey), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const fingerprint = `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, "")}`;
  const command = `ssh ${target.port === 22 ? "" : `-p ${target.port} `}${target.user}@${target.host}`;
  return confirmAction({
    title: "Use this key to connect?",
    description: (
      <div className="flex flex-col gap-3">
        <dl className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-strong text-body text-foreground">Connecting node</dt>
            <dd className="break-words text-detail text-muted-foreground">{selection.nodeName}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-strong text-body text-foreground">Key file</dt>
            <dd className="break-all font-mono text-detail text-muted-foreground">{selection.keyFileName}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-strong text-body text-foreground">SSH command</dt>
            <dd className="break-all font-mono text-detail text-muted-foreground">{command}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-strong text-body text-foreground">Host fingerprint</dt>
            <dd className="break-all font-mono text-detail text-muted-foreground">{fingerprint}</dd>
          </div>
        </dl>
        <p>
          The node “{selection.nodeName}” supplied this fingerprint. Verify it through a trusted channel before
          continuing.
        </p>
      </div>
    ),
    confirmLabel: "Use key and connect",
  });
}
