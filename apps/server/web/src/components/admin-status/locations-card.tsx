import { CopyableValue, Fact, FactCard } from "@internal/node-admin";
import type { ServerDeployment } from "@/types/server-deployment";

/** A fact whose value is a path, or an em-dash when there is none. */
function PathFact({ label, value }: { label: string; value: string | null }) {
  return (
    <Fact label={label} mono wide>
      {value ? <CopyableValue value={value} label={label} /> : "—"}
    </Fact>
  );
}

/**
 * Everything this server reads or writes, by path (spec 2026-09-12 § 4.3,
 * moved to the Status page by spec 2026-09-14).
 *
 * Read-only on purpose — which is why it lives on Status rather than Service:
 * it carries no act, and Status is where an admin sees what the instance
 * currently IS. The database path in particular is settable by the CLI and
 * not by this page: moving it from a web form is a footgun with no undo, so
 * the page shows where it is and stops there.
 */
export function LocationsCard({ view }: { view: ServerDeployment }) {
  return (
    <FactCard title="Locations">
      <Fact label="Config file" mono wide>
        <CopyableValue value={view.configEnv.path} label="Config file" />
        {!view.configEnv.exists && <span className="text-muted-foreground">missing</span>}
      </Fact>
      <PathFact label="Data directory" value={view.paths.dataDir} />
      <PathFact label="Database" value={view.paths.database} />
      <PathFact label="Pane logs" value={view.paths.logsDir} />
      <PathFact label="Node artifacts" value={view.paths.nodeArtifacts} />
      <Fact label="Service definition" mono wide>
        {view.service.definitionPath ? (
          <CopyableValue value={view.service.definitionPath} label="Service definition" />
        ) : (
          "not installed"
        )}
      </Fact>
      <PathFact label="Server log" value={view.paths.serverLog} />
      <PathFact label="Service manager log" value={view.service.logPath ?? view.service.logHint} />
    </FactCard>
  );
}
