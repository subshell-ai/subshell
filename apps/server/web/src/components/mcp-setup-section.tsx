import { CopyCommandRow } from "@/components/copy-command-row";
import type { McpSetupInfo } from "@/types/harness";

/**
 * The "Cross-subshell comms" block in the profile form: how subshells from this
 * harness reach the subshell MCP tools (channels + subshell orchestration). Auto
 * harnesses (claude-code, opencode) need nothing — one quiet line says so.
 * Harnesses with no per-subshell config (hermes, pi) get their one-time
 * registration steps with copy buttons: after that single registration the
 * subshell-spawned child inherits each subshell's credentials and works
 * per-subshell. The registration belongs on the NODE that runs the harness,
 * which a profile may not pin — so the copy names the node rather than saying
 * "this machine", which is a browser.
 */
export function McpSetupSection({ mcp }: { mcp: McpSetupInfo }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">Cross-subshell comms</p>
      {mcp.mode === "auto" ? (
        <p className="text-muted-foreground text-xs">{mcp.summary}</p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            This harness has no per-subshell config, so register subshell once on each node that runs it — every
            subshell there then picks up its own credentials automatically:
          </p>
          <div className="space-y-2">
            {mcp.steps.map((step) => (
              <div key={step.label} className="space-y-1">
                <p className="text-muted-foreground text-xs">{step.label}</p>
                <CopyCommandRow text={step.command} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
