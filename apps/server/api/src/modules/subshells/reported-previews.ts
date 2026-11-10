/**
 * Preview ports a harness reported about its own pane.
 *
 * Discovery attributes listening sockets by walking the pane's process tree.
 * A harness that brokers its tool shells through a shared daemon leaves that
 * tree, so the server it started is reachable but invisible. The harness
 * reports the ports instead, and this registry merges them into the pane's
 * view list.
 *
 * The state is intentionally in-memory and transient, like the subagent
 * roster: a control-plane restart forgets everything and the harness
 * re-reports, a pane restart invalidates the previous run through its
 * `startedAt` generation, and nothing here ever starts a process or dials a
 * host. A report carries a port only, never an address, so a pane cannot use
 * it to point the proxy at another machine.
 */

/** One reported port, stamped so a silent reporter's rows expire. */
export interface ReportedPreviewPort {
  port: number;
  title?: string;
  reportedAt: number;
}

/** How long a port stays listed after the harness last mentioned it. */
export const REPORTED_PREVIEW_TTL_MS = 30 * 60_000;

/** The most ports one pane may report; a longer report keeps the first rows. */
export const REPORTED_PREVIEWS_MAX = 32;

interface State {
  /** The pane's `startedAt`; a restart is a new harness and drops the old rows. */
  generation: string;
  rows: Map<number, ReportedPreviewPort>;
}

/**
 * The ports every live pane's harness has reported, keyed by subshell id.
 * A generation change or an expired row is pruned on the next read, so the
 * picker never shows a port the harness stopped mentioning indefinitely.
 */
export class ReportedPreviews {
  private states = new Map<string, State>();

  /**
   * Merge one report into a pane's set. `generation` is the pane row's
   * `startedAt`: a different run replaces everything, because the ports
   * belonged to the harness process that reported them.
   */
  report(subshellId: string, generation: string, ports: readonly { port: number; title?: string }[]): void {
    let state = this.states.get(subshellId);
    if (!state || state.generation !== generation) {
      state = { generation, rows: new Map() };
      this.states.set(subshellId, state);
    }
    const now = Date.now();
    this.prune(state, now);
    for (const row of ports) {
      if (state.rows.size >= REPORTED_PREVIEWS_MAX && !state.rows.has(row.port)) continue;
      state.rows.set(row.port, { port: row.port, ...(row.title ? { title: row.title } : {}), reportedAt: now });
    }
  }

  /** The unexpired ports for one live run, sorted by port. */
  read(subshellId: string, generation: string): ReportedPreviewPort[] {
    const state = this.states.get(subshellId);
    if (!state) return [];
    if (state.generation !== generation) {
      this.states.delete(subshellId);
      return [];
    }
    this.prune(state, Date.now());
    if (state.rows.size === 0) {
      this.states.delete(subshellId);
      return [];
    }
    return [...state.rows.values()].sort((a, b) => a.port - b.port);
  }

  private prune(state: State, now: number): void {
    for (const [port, row] of state.rows) {
      if (now - row.reportedAt > REPORTED_PREVIEW_TTL_MS) state.rows.delete(port);
    }
  }
}

/**
 * The registry for one database context. Both the report route and the view
 * list must reach the SAME instance; keying on the context keeps a test file's
 * registry separate from the next file's without a module-global singleton.
 */
const registries = new WeakMap<object, ReportedPreviews>();
export function reportedPreviews(context: object): ReportedPreviews {
  let value = registries.get(context);
  if (!value) {
    value = new ReportedPreviews();
    registries.set(context, value);
  }
  return value;
}
