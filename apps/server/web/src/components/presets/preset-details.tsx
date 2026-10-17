import { FactList } from "@/components/fact-list";
import { useNodes } from "@/hooks/use-nodes";
import { SSH_AUTHENTICATION_LABELS } from "@/lib/ssh-preset";
import type { PresetRow, SshPreset } from "@/types/preset";

/** Shared viewers inspect the complete stored choices without editable controls. */
export function PresetDetails({ preset }: { preset: PresetRow | SshPreset }) {
  const nodes = useNodes();
  const nodeName = (id: string | null) =>
    nodes.data?.nodes.find((node) => node.id === id)?.name ?? (nodes.isPending ? "Loading…" : "Node unavailable");
  const common = [
    { label: "Name", value: preset.name },
    { label: "Description", value: preset.description || "None" },
    { label: "Owner", value: preset.ownerName ?? preset.userId ?? "You" },
  ];
  return (
    <FactList
      rows={
        preset.kind === "ssh"
          ? [
              ...common,
              { label: "Destination", value: preset.destination, mono: true },
              { label: "Connect from", value: nodeName(preset.nodeId) },
              { label: "Authentication", value: SSH_AUTHENTICATION_LABELS[preset.authentication] },
              {
                label: "Key source",
                value:
                  preset.authentication === "remote"
                    ? nodeName(preset.keyHome)
                    : preset.authentication === "connecting"
                      ? nodeName(preset.nodeId)
                      : preset.authentication === "local-key"
                        ? "Your machine"
                        : "Not used",
              },
              { label: "Alias", value: preset.alias ?? "None" },
              { label: "Resolution name", value: preset.resolutionAlias ?? preset.destination, mono: true },
              { label: "Selected keys", value: preset.fingerprints.join("\n") || "None", mono: true },
              {
                label: "Port forwards",
                value: preset.forwards.length
                  ? preset.forwards.map((forward) => (
                      <div key={`${forward.kind}:${forward.bindHost}:${forward.listenPort}`}>
                        {forward.kind === "dynamic" ? "SOCKS proxy" : forward.kind === "local" ? "Local" : "Remote"}:{" "}
                        {forward.bindHost ?? "127.0.0.1"}:{forward.listenPort}
                        {forward.kind !== "dynamic" && ` → ${forward.targetHost}:${forward.targetPort}`}
                      </div>
                    ))
                  : "None",
                mono: true,
              },
            ]
          : [
              ...common,
              { label: "Agent", value: preset.harnessId },
              { label: "Environment variables", value: preset.envJson ?? "None", mono: true },
              { label: "Flags", value: preset.flagsJson ?? "None", mono: true },
              { label: "Settings", value: preset.settingsJson ?? "None", mono: true },
              { label: "Isolate configuration", value: preset.configIsolation ? "Yes" : "No" },
              { label: "Auto-restart", value: preset.restartOnExit ? "Yes" : "No" },
              { label: "Cross-subshell communication", value: preset.crossCommEnabled ? "Yes" : "No" },
              { label: "Node", value: preset.nodeId ? nodeName(preset.nodeId) : "Choose when launching" },
              { label: "Working directory", value: preset.workingDir ?? "Choose when launching", mono: true },
              { label: "Prompt blocks", value: preset.promptBlocks ?? "None", mono: true },
            ]
      }
    />
  );
}
