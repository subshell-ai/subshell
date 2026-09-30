import { CopyCommandRow } from "@/components/copy-command-row";
import type { McpSetupInfo } from "@/types/harness";

/**
 * The "Cross-subshell comms" registration steps for a MANUAL harness (hermes,
 * pi): after that one-time registration the subshell-spawned child inherits
 * each subshell's credentials and works per-subshell. The registration belongs
 * on the NODE that runs the harness, which a preset may not name — so the copy
 * names the node rather than saying "this machine", which is a browser.
 *
 * AUTO harnesses (claude-code, opencode) render NOTHING here, and that is the
 * whole of it (operator ruling 2026-09-30): their one quiet line said the
 * launch wires MCP by itself — true, and nothing anyone must do — while
 * reading as a duplicate of the new "Cross-subshell comms" switch right above
 * it. A sentence with no act in it is the first candidate for removal.
 */
export function McpSetupSection({ mcp }: { mcp: Extract<McpSetupInfo, { mode: "manual" }> }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">Cross-subshell comms</p>
      <p className="text-detail text-muted-foreground">
        This harness has no per-subshell config, so register subshell once on each node that runs it. Every subshell
        there then picks up its own credentials automatically:
      </p>
      <div className="space-y-2">
        {mcp.steps.map((step) => (
          <div key={step.label} className="space-y-1">
            <p className="text-detail text-muted-foreground">{step.label}</p>
            <CopyCommandRow text={step.command} />
          </div>
        ))}
      </div>
    </div>
  );
}
