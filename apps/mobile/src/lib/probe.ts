/**
 * The save-time probe (spec §Error handling): REST reachability plus a
 * verdict on whether WebSocket upgrades tunnel. Phones reach the instance
 * through a proxy that may forward HTTP but not upgrades — that exact shape
 * is what this classifies, so the Live tab can hide itself with a standing
 * banner instead of hanging. Injected deps only: no fetch/socket here.
 */

/** Outcome of one probe. */
export interface ProbeResult {
  /** REST answered (anything over HTTP, incl. 4xx). */
  ok: boolean;
  /** Instance wants the web setup wizard first. */
  needsSetup: boolean;
  /** REST up but upgrades never land — hide Live, keep everything else. */
  wsBlocked: boolean;
}

/** Injected probe transport (the screen wires fetch + a real WebSocket). */
export interface ProbeDeps {
  /** Resolves with `GET /api/setup/status`; throws/rejects when unreachable. */
  fetchSetupStatus: (origin: string) => Promise<{ needsSetup: boolean }>;
  /** Opens the probe socket; resolves once it opened, closed, or timed out. */
  openProbeSocket: (origin: string) => Promise<{ opened: boolean; closeCode: number | null }>;
}

/**
 * @param origin - Normalized instance origin (no trailing slash)
 * @param deps - Injected transport (fetch + WebSocket behind seams)
 */
export async function probeInstance(origin: string, deps: ProbeDeps): Promise<ProbeResult> {
  let needsSetup = false;
  try {
    const status = await deps.fetchSetupStatus(origin);
    needsSetup = status.needsSetup;
  } catch {
    // Nothing is reachable; the ws probe would "fail" for the same wrong reason.
    return { ok: false, needsSetup: false, wsBlocked: false };
  }
  const ws = await deps.openProbeSocket(origin);
  // Any close code means the upgrade reached mote's WS server and was answered;
  // a bare timeout/error with REST up means a proxy dropped it.
  const reachable = ws.opened || ws.closeCode !== null;
  return { ok: true, needsSetup, wsBlocked: !reachable };
}
