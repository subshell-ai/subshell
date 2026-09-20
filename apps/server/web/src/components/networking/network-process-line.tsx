import { relativeElapsed } from "@internal/node-admin";
import type { SupervisorStateWire } from "@/types/network";

/**
 * The daemon this plugin keeps alive, in one line plus its own last word.
 *
 * Only rendered where a plugin actually supervises a process, which is not
 * every network: some publish by talking to a daemon the OS already runs. A
 * row that supervises nothing says nothing here rather than claiming a
 * process that does not exist.
 *
 * Three facts, and the third is the one that matters when something is wrong:
 * whether it is up, how many times it has been restarted (a number that is
 * interesting only when it is not zero — a flapping tunnel looks healthy in
 * every snapshot), and how the last run ENDED. Under them, the process's own
 * most recent line, verbatim: there is nothing to derive from a tunnel's
 * output, and inventing stages it does not report would be worse than showing
 * what it says.
 */
/**
 * "2m ago", or a bare "just now" — `relativeElapsed` answers "just now" under
 * a minute, so an unconditional suffix reads "just now ago".
 */
function ago(iso: string): string {
  const elapsed = relativeElapsed(iso);
  return elapsed === "just now" ? "just now" : `${elapsed} ago`;
}

export function NetworkProcessLine({ process }: { process: SupervisorStateWire }) {
  const last = process.lastLines.at(-1);
  return (
    <div className="space-y-1">
      <p className="text-detail text-muted-foreground">
        <span className={process.running ? "text-success" : "text-warning"}>
          {process.running ? "Running" : "Stopped"}
        </span>
        {process.running && process.pid !== undefined && <> · pid {process.pid}</>}
        {process.running && process.since && <> · started {ago(process.since)}</>}
        {/* Zero restarts is the uninteresting case and is left out: a count
            of 0 on every healthy row teaches a reader to stop reading it,
            which is the one moment it stops being zero. */}
        {process.restarts > 0 && <> · {process.restarts} restarts</>}
      </p>
      {!process.running && process.lastExit && (
        <p className="text-detail text-muted-foreground">
          Last exit {process.lastExit.code === null ? "on a signal" : `with code ${process.lastExit.code}`},{" "}
          {ago(process.lastExit.at)}.
        </p>
      )}
      {last !== undefined && last.trim() !== "" && (
        <p className="truncate font-mono text-detail text-muted-foreground">{last}</p>
      )}
    </div>
  );
}
