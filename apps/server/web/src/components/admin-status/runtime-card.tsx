import { Fact, FactCard } from "@/components/admin-status/fact-list";
import { Badge } from "@/components/ui/badge";
import type { AdminStatus } from "@/hooks/use-admin-status";
import { formatBytes, formatDuration } from "@/lib/format-units";

/**
 * The host as this process sees it — essentially `subshell-server status`,
 * readable from a browser.
 *
 * Two of these are failure states an admin should be able to spot without
 * reading a log: no tmux means every LOCAL pane launch fails, and an
 * unresolved MCP entrypoint means every subshell create 500s. Both hide until
 * a user hits them, which is why they are badged rather than merely printed.
 */
export function RuntimeCard({ status }: { status: AdminStatus }) {
  const { runtime } = status;
  return (
    <FactCard title="Runtime">
      <Fact label="Uptime">{formatDuration(runtime.uptimeSeconds)}</Fact>
      <Fact label="Booted">{new Date(runtime.bootedAt).toLocaleString()}</Fact>
      <Fact label="Mode">
        <Badge variant={runtime.production ? "success" : "muted"}>
          {runtime.production ? "production" : "development"}
        </Badge>
      </Fact>
      <Fact label="Host" mono>
        {runtime.hostname}
      </Fact>
      <Fact label="Platform" mono>
        {runtime.os} · {runtime.arch}
      </Fact>
      <Fact label="Process" mono>
        pid {runtime.pid}
      </Fact>
      <Fact label="Memory (RSS)">{formatBytes(runtime.memoryRssBytes)}</Fact>
      <Fact label="Heap used">{formatBytes(runtime.memoryHeapUsedBytes)}</Fact>
      <Fact label="Serving SPA from">
        {/* `disk` on a compiled binary run from a checkout is the documented
            trap: the repo's own dist shadows the embedded copy. */}
        <Badge variant="outline">{runtime.staticSource}</Badge>
      </Fact>
      <Fact label="Listening on" mono wide>
        {runtime.listenHost}:{runtime.listenPort} · base URL {runtime.appBaseUrl}
      </Fact>
      {/* Size only: the path is stated once, copyably, by the Locations card
          on this same page (spec 2026-09-14 § 2.2). */}
      <Fact label="Database size">{formatBytes(runtime.databaseBytes)}</Fact>
      <Fact label="tmux" mono wide>
        {runtime.tmuxPath ?? <Badge variant="warning">not found: subshells cannot launch on the server</Badge>}
      </Fact>
      <Fact label="MCP entrypoint" mono wide>
        {runtime.mcpEntrypoint ? (
          <>
            {runtime.mcpEntrypoint} <span className="text-muted-foreground">(via {runtime.mcpSource})</span>
          </>
        ) : (
          <Badge variant="warning">unresolved: creating a subshell will fail</Badge>
        )}
      </Fact>
    </FactCard>
  );
}
