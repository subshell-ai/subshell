import { confirmAction } from "@internal/node-admin";
import { browserHostFingerprint } from "@/lib/ssh-browser-signer-core";
import type { LocalKeyPreparation } from "@/lib/ssh-local-key";

/** Approval precedes reading the selected private file or sending any authentication signature. */
export async function verifyBrowserKeyDestination(
  target: LocalKeyPreparation,
  selection: { keyFileName: string; nodeName: string },
): Promise<boolean> {
  // The signer core's validated fingerprint is the ONLY fingerprint here: a
  // raw digest of whatever bytes arrived would let a malformed blob render a
  // number the person then trusts, before the worker refuses the same blob.
  let fingerprint: string;
  try {
    fingerprint = await browserHostFingerprint(target.hostKey);
  } catch {
    throw new Error("The host key the connecting node supplied isn't a supported SSH key. Ask it to scan again.");
  }
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
