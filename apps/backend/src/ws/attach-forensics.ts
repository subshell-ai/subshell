import { mkdirSync, writeFileSync } from "node:fs";
import { logger } from "@/utils/logger.js";

/**
 * Attach forensics — a per-attach on-disk record that makes the NEXT
 * "still garbled" report provable to a layer (2026-09-01).
 *
 * The open question after the capture-only replay + gap-free join redesign:
 * is the garble in the PANE (a half-repainted frame at entry time that
 * `capture-pane` faithfully ships), in the STREAM (a skipped/late diff), or
 * in the CLIENT (xterm-side rendering of a clean stream)? The server can only
 * prove the first two — the pane's contents at attach time and the exact
 * bytes it sent. That is what this dumps:
 *
 *   /tmp/subshell-attach-debug/<session>/<timestamp>/pre-resize.txt  the pane
 *     grid BEFORE the pre-capture resize (the state the pane was in when the
 *     viewer arrived)
 *   /tmp/subshell-attach-debug/<session>/<timestamp>/replay.txt      the EXACT
 *     `replay` frame the client was sent (post marker-strip, post-resize
 *     capture)
 *
 * Compare `pre-resize.txt` with `replay.txt` (and with `tmux capture-pane` on
 * the same pane taken later): if the pre-resize grid is already mid-word
 * garbage, the pane held a half-repainted frame at entry (the repaint was
 * late — see the `repainted=`/`nudged=` flags on the `ws attach` journal
 * line); if the replay is clean, the server is innocent and the fault is the
 * client's rendering of a clean stream.
 *
 * OFF by default — the dumps are real terminal output (potentially secrets on
 * screen) and writing them on every attach would churn `/tmp`. Enable per
 * instance with `SUBSHELL_ATTACH_DEBUG=1` (a systemd drop-in env line for the
 * live service; {@link setForensicsEnabledForTests} in suites).
 */

/** Mutable so tests can toggle; read from the environment once at module load. */
let enabled = process.env.SUBSHELL_ATTACH_DEBUG === "1" || process.env.SUBSHELL_ATTACH_DEBUG === "true";
/** Where per-attach dumps are written. */
const FORENSICS_ROOT = "/tmp/subshell-attach-debug";

/**
 * Turn forensics on/off for this process. Tests flip it around a case so the
 * real `/tmp` is never touched.
 * @internal
 */
export function setForensicsEnabledForTests(on: boolean): void {
  enabled = on;
}

/** Whether attach forensics dumps are being written for this instance. */
export function forensicsEnabled(): boolean {
  return enabled;
}

/**
 * Dumps the pre-resize grid and the exact replay bytes for one attach into a
 * fresh timestamped subdirectory. Best-effort: any fs failure (dir not
 * writable, full disk) is logged at debug and swallowed — forensics must
 * never break an attach.
 *
 * @param sessionId - the session being attached to (subdirectory name)
 * @param preResize - the pane's visible grid captured BEFORE the pre-capture
 *   resize (`null` when no resize ran — stale geometry or a missing pane
 *   state, in which case the dump still records the replay)
 * @param replay - the exact `replay` frame content sent to the client
 * @returns the per-attach directory, or `null` when forensics are disabled or
 *   a write failed
 */
export function writeAttachForensics(sessionId: string, preResize: string | null, replay: string): string | null {
  if (!enabled) return null;
  try {
    const dir = `${FORENSICS_ROOT}/${sessionId}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/pre-resize.txt`, preResize ?? "<no pre-resize capture>", "utf8");
    writeFileSync(`${dir}/replay.txt`, replay, "utf8");
    return dir;
  } catch (err) {
    logger.withError(err).debug(`attach forensics dump failed for ${sessionId}`);
    return null;
  }
}

/** What one attach's paint is recorded with (both attach paths report the same facts). */
export interface AttachPaintFacts {
  /** Session that was painted. */
  sessionId: string;
  /** The pane grid captured before the pre-capture resize; null when forensics are off or no resize ran. */
  preResize: string | null;
  /** The exact replay frame content sent to the client. */
  replay: string;
  /** Whether the app's real repaint burst was observed before the capture. */
  repainted: boolean;
  /** Whether the pane had to be nudged (±1 col) to force that repaint. */
  nudged: boolean;
}

/**
 * Records one attach's paint: writes the forensics dump (when enabled) and
 * emits the verdict as a `ws attach` journal line, so the documented
 * `journalctl --user -u subshell-server.service | grep "ws attach"` still finds
 * everything about an attach in one place.
 *
 * The `repainted=`/`nudged=` pair is what makes the next "still garbled"
 * report diagnosable without guessing: `repainted=false nudged=true` means
 * the pane refused to repaint even for a forced SIGWINCH (so a garbled replay
 * is the pane's own state, not ours), while `repainted=true` means the client
 * was sent a freshly painted frame — and if it still looks wrong, the fault is
 * downstream of the capture.
 */
export function recordAttachPaint(facts: AttachPaintFacts): void {
  const dir = writeAttachForensics(facts.sessionId, facts.preResize, facts.replay);
  logger.info(
    `ws attach ${facts.sessionId}: painted repainted=${facts.repainted} nudged=${facts.nudged} ` +
      `replay=${facts.replay.length}B dump=${dir ?? "off"}`,
  );
}
