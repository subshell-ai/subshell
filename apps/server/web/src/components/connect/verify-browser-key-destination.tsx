import { confirmAction } from "@internal/node-admin";
import { FactList } from "@/components/fact-list";
import { WarningNotice } from "@/components/ui/notice";
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
        <FactList
          rows={[
            { label: "Connecting node", value: selection.nodeName },
            { label: "Key file", value: selection.keyFileName, mono: true },
            { label: "SSH command", value: command, mono: true, copyText: command },
            { label: "Host fingerprint", value: fingerprint, mono: true, copyText: fingerprint },
          ]}
        />
        <WarningNotice>
          The node “{selection.nodeName}” supplied this fingerprint. Verify it through a trusted channel before
          continuing.
        </WarningNotice>
      </div>
    ),
    confirmLabel: "Use key and connect",
  });
}
