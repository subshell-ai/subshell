import type { SshForwardWire } from "@internal/subshell-protocol";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";
export function sshPresetView(row: SshPresetTable) {
  return {
    ...row,
    kind: "ssh" as const,
    fingerprints: row.fingerprints === null ? [] : (JSON.parse(row.fingerprints) as string[]),
    forwards: row.forwards === null ? [] : (JSON.parse(row.forwards) as SshForwardWire[]),
  };
}
