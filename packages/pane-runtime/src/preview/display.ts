import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { isNodeSubshellId as isSubshellId, type NodePreviewScreenLost } from "@internal/subshell-protocol";
import { pathAllowed } from "../ssh/relay/path-policy.js";
// The handle type lives in ports.ts (Task 4 defined it for the wire row); a
// TYPE ALIAS there, not the protocol's interface, is what keeps command
// results legal: `CommandResult.data` is `Record<string, JsonValue>`, and an
// interface has no implicit index signature, so the protocol's
// `NodePreviewScreenWire` is structurally identical but refuses to serialize
// through it. The alias satisfies that interface at every use site.
import type { PreviewScreenHandle } from "./ports.js";

const ORPHAN_SSH_DIR_MIN_AGE_MS = 60 * 60 * 1000;
const PREVIEW_NODE_OFF = "preview-node-off: turn on Preview for this node";

/**
 * Virtual displays (pane-preview spec §5, Task 7): the Xvfb + x11vnc pair a
 * `screen` launch allocates, per pane, on this machine. A pane that asks for
 * a screen gets its OWN display number - `:90` upward, each claimed through
 * an O_EXCL lockfile so two launches can never mint the same one - its own
 * xauth cookie minted BEFORE anything spawns, and its own loopback-only RFB
 * port, which is what the plane's proxy later dials (decision 6's
 * rfbPort discriminator). Everything here is allocation and lifecycle, not
 * pixels: the screencast rides the CDP bridge's own plane, and a pane's
 * plain terminal keeps streaming whether or not its display is alive.
 *
 * Two facts earn the ceremony:
 * - `xauth add` (not `generate`) is the mint that works with no live display.
 *   `generate` opens the display to read a cookie - Xvfb is not up yet - and
 *   its `-f` is a GLOBAL option that a post-subcommand `-f` silently stops
 *   honoring; both halves measured on a real host (rc=1). The pane's
 *   `XAUTHORITY` and x11vnc's `-auth` read the SAME file, so whatever cookie
 *   Xvfb ends up writing into it is the one both sides use.
 * - The daemon's own kills go through {@link PreviewDisplays.closeFor} (or
 *   the sweep), which deregisters BEFORE signalling, so the child-exit watch
 *   never mistakes a teardown for a loss. Only a mid-pane vanish - a child
 *   dying while the entry is still registered - marks
 *   {@link PreviewDisplays.lostFor}: the exit watch for children this daemon
 *   spawned, and the sweep's signal-0 probe of the recorded pids for entries
 *   it merely rehydrated. Both mark without touching the pane: spec §9's
 *   posture is a darkened Screen affordance that can say WHY, not a killed
 *   terminal.
 *
 * Durability is deliberately half-hearted: `display.json` records the pids
 * incrementally (every crash window leaves the pids that exist) so the
 * restart sweep can kill or re-verify children the in-memory registry lost,
 * but the `lostFor` marker is memory-only - after a daemon restart the
 * affordance simply disappears, safely, because the sweep has already freed
 * the lock and dir the dead display left.
 */

/** The display-number range spec §5 bounds: nothing on a node lives below `:90`. */
const DISPLAY_MIN = 90;
const DISPLAY_MAX = 199;
/** Where the RFB chooser starts. 5900-5909 stay the range of real X displays. */
const RFB_PORT_MIN = 5910;
const RFB_PORT_PROBES = 100;
/** How long Xvfb and x11vnc get to come up before the allocation is refused. */
const DEFAULT_READY_BUDGET_MS = 5000;
/** Readiness poll cadence. */
const READY_POLL_MS = 100;

/** The platform refusal, named by the switch's spec §5 rule: no X server stack, out loud. */
export const PREVIEW_DISPLAY_UNSUPPORTED = "preview-display-unsupported";
/** Missing-binary refusal; the thrown message names the binary (`: x11vnc`). */
export const PREVIEW_DISPLAY_MISSING_BINARIES = "preview-display-missing-binaries";
/** Nothing came up inside the budget (or no number/port was free); detail names which. */
export const PREVIEW_DISPLAY_NOT_READY = "preview-display-not-ready";

/**
 * The X auth file for one pane's display, byte-derived from `dataDir` the
 * same way ssh-render derives the per-pane config path (the mirror's pane-id
 * guard applies; the same shape feeds the launch env's `XAUTHORITY`).
 */
export function xauthorityPath(dataDir: string, paneId: string): string {
  return join(dataDir, "displays", paneId, "Xauthority");
}

/** A spawned display child, narrowed to what a lane of this registry uses. */
export interface DisplayChild {
  pid: number;
  /** Resolves with the exit code; the watch treats a rejection like an exit. */
  exited: Promise<number>;
}

/** The mechanics a caller (or a test) can replace. Production passes none. */
export interface DisplayDeps {
  isEnabled?: () => boolean | Promise<boolean>;
  log?: (line: string) => void;
  /** Spawn a long-lived child with BOTH streams appended to `logPath`. Defaults to `Bun.spawn` over an O_APPEND 0600 fd. */
  spawn?: (argv: string[], opts: { logPath: string }) => DisplayChild;
  /** Run to completion; returns the exit code. Defaults to `Bun.spawnSync`. */
  spawnSync?: (argv: string[]) => number;
  /** The ONE binary-lookup seam (wraps `Bun.which`): the refusal names the missing binary. */
  which?: (name: string) => string | null;
  /** Readiness poll sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (budget math); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Is `port` already occupied? The chooser SKIPS occupied ports; readiness
   * and rehydration POLL for the port to answer YES (x11vnc listening).
   * One seam, both directions, the way one bind-probe answers both questions.
   */
  bindProbe?: (port: number) => Promise<boolean>;
  /** Signal a pid (0 = liveness probe). Throws ESRCH-style for dead pids, like `process.kill`. */
  kill?: (pid: number, signal?: number | string) => void;
  /** Does `/tmp/.X11-unix/X<NN>` exist? Its own seam because `-nolisten tcp` leaves no port to bind-probe. */
  xSocketReady?: (displayNumber: number) => boolean;
  /** Readiness budget; defaults to {@link DEFAULT_READY_BUDGET_MS}. */
  readyBudgetMs?: number;
}

/** The one record the sweep reads off disk. Written incrementally, newest field last. */
interface DisplayRecord {
  display?: unknown;
  rfbPort?: unknown;
  xvfbPid?: unknown;
  x11vncPid?: unknown;
}

interface DisplayEntry {
  paneId: string;
  display: string;
  displayNumber: number;
  rfbPort: number;
  xvfbPid: number;
  x11vncPid: number;
  /** Spawned handles when THIS process started the display; undefined on a rehydrated entry. */
  xvfbChild?: DisplayChild;
  vncChild?: DisplayChild;
  /**
   * Earliest sweep-clock time at which this entry may be torn down for
   * ABSENT-FROM-CENSUS. A launch registers its display moments before the
   * meta row the census reads exists, so "absent" is not yet "dead" right
   * after `openFor`: a fresh entry gets registration + one minute. A
   * rehydrated entry's registration time is meaningless (it did not happen
   * now), so it carries the record's own mtime under the launch floor it was
   * rehydrated past - which is already in the past, and correct.
   */
  sweptAfter: number;
}

/** Pass 1's fresh-entry floor: the census races the launch by far less than this. */
const DISPLAY_CENSUS_FRESH_MS = 60_000;

/** What a `sweepOrphans` pass did, for the one log line it earns. */
export interface DisplaySweepResult {
  reaped: number;
  rehydrated: number;
  locksFreed: number;
}

const bunSpawn = (argv: string[], opts: { logPath: string }): DisplayChild => {
  // One O_APPEND fd opened at 0600 serves BOTH streams: two Bun-file
  // redirects would each truncate the same path. The child inherits the fd;
  // this copy closes the moment spawn returns.
  const fd = openSync(opts.logPath, "a", 0o600);
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: fd, stderr: fd });
    return { pid: child.pid, exited: child.exited };
  } finally {
    closeSync(fd);
  }
};

const bunSpawnSync = (argv: string[]): number => {
  const r = Bun.spawnSync(argv, { stdin: "ignore" });
  return r.exitCode ?? 1;
};

const bunWhich = (name: string): string | null => Bun.which(name) ?? null;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is something already listening on this loopback port? A connect SUCCEEDING
 * means occupied (the probe's socket is destroyed instantly - an RFB server
 * just sees a client blink); a refused connect means free; a HANG counts as
 * occupied because a socket that accepts-nothing still reserves the port.
 */
const portOccupied = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = netConnect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(500);
    s.on("connect", () => finish(true));
    s.on("timeout", () => finish(true));
    s.on("error", () => finish(false));
  });

const socketExists = (displayNumber: number): boolean => existsSync(`/tmp/.X11-unix/X${displayNumber}`);

/**
 * Per-daemon display registry, exactly like `RelaySessions` and
 * `PreviewForward`: built at boot, injected through
 * {@link import("../commands/context.js").CommandContext}, and nothing out
 * of it survives the process except the dirs and locks the sweep reconciles.
 */
export class PreviewDisplays {
  readonly dataDir: string;
  private readonly defaults: DisplayDeps;
  private readonly entries = new Map<string, DisplayEntry>();
  /** paneId -> the binary that died mid-pane; memory-only by the header's reason. */
  private readonly lost = new Map<string, NodePreviewScreenLost>();

  constructor(dataDir: string, deps: DisplayDeps = {}) {
    this.dataDir = dataDir;
    this.defaults = deps;
  }

  /** The registered display for this pane, or null (the ports arm's `screen` half). */
  getFor(paneId: string): PreviewScreenHandle | null {
    const e = this.entries.get(paneId);
    return e ? { display: e.display, rfbPort: e.rfbPort } : null;
  }

  /** The named mid-pane loss for this pane, or null. Set by the exit watch, cleared by the next open. */
  lostFor(paneId: string): NodePreviewScreenLost | null {
    return this.lost.get(paneId) ?? null;
  }

  /**
   * Allocate the pane's display: platform -> mirror -> binaries -> lock ->
   * files -> Xvfb -> RFB port -> x11vnc -> readiness, and a REFUSAL throws
   * (the dispatcher answers `{ ok: false, error: message }`) with whatever
   * it started already torn down. The gate order is the spec's: the switch
   * is checked HERE so every entry point refuses with one voice, and the
   * binaries are checked before the lock/dir exist, so a machine that cannot
   * serve a screen leaves no litter.
   *
   * Idempotent for a registered pane (a relaunch re-reads its own handle and
   * spawns nothing). `over` layers per-call seams on the constructor's.
   */
  async openFor(
    paneId: string,
    size: { width: number; height: number },
    over?: DisplayDeps,
  ): Promise<PreviewScreenHandle> {
    const d = this.deps(over);
    if (process.platform !== "linux") throw new Error(PREVIEW_DISPLAY_UNSUPPORTED);
    if ((await this.defaults.isEnabled?.()) !== true) throw new Error(PREVIEW_NODE_OFF);
    if (!isSubshellId(paneId)) throw new Error("invalid subshell id");
    const existing = this.entries.get(paneId);
    if (existing) return { display: existing.display, rfbPort: existing.rfbPort };

    const xvfbBin = d.which("Xvfb");
    if (!xvfbBin) throw new Error(`${PREVIEW_DISPLAY_MISSING_BINARIES}: Xvfb`);
    const vncBin = d.which("x11vnc");
    if (!vncBin) throw new Error(`${PREVIEW_DISPLAY_MISSING_BINARIES}: x11vnc`);
    const xauthBin = d.which("xauth");
    if (!xauthBin) throw new Error(`${PREVIEW_DISPLAY_MISSING_BINARIES}: xauth`);

    const root = join(this.dataDir, "displays");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const displayNumber = this.claimNumber(root);
    const display = `:${displayNumber}`;
    const lockPath = join(root, `.display-${displayNumber}.lock`);
    const paneDir = join(root, paneId);
    const auth = xauthorityPath(this.dataDir, paneId);
    let xvfbChild: DisplayChild | undefined;
    let vncChild: DisplayChild | undefined;
    try {
      // The lock's CONTENT names the holder - a human reading `.display-91.lock`
      // mid-incident wants the pane, and the sweep pairs dir-to-lock anyway.
      writeFileSync(lockPath, `${paneId}\n`, { mode: 0o600 });
      mkdirSync(paneDir, { recursive: true, mode: 0o700 });

      // Mint the cookie BEFORE anything spawns (the header's xauth account).
      const cookie = randomBytes(16).toString("hex");
      const rc = d.spawnSync([xauthBin, "-f", auth, "add", display, ".", cookie]);
      if (rc !== 0) throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: xauth add failed (rc ${rc})`);
      chmodSync(auth, 0o600); // whoever created the file, this module's file mode is 0600

      // Pre-create both logs at 0600 (the spawn fd appends; the mode is set here).
      const xvfbLog = join(paneDir, "Xvfb.log");
      const vncLog = join(paneDir, "x11vnc.log");
      for (const logFile of [xvfbLog, vncLog]) {
        const fd = openSync(logFile, "a", 0o600);
        closeSync(fd);
      }
      const envFile = join(paneDir, "display.env");
      writeFileSync(envFile, `DISPLAY=${display}\nXAUTHORITY=${auth}\n`, { mode: 0o600 });
      chmodSync(envFile, 0o600);

      xvfbChild = d.spawn(
        [xvfbBin, display, "-auth", auth, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"],
        { logPath: xvfbLog },
      );
      writeRecord(paneDir, { display, xvfbPid: xvfbChild.pid });

      const rfbPort = await this.chooseRfbPort(d);
      vncChild = d.spawn(
        [vncBin, "-display", display, "-auth", auth, "-localhost", "-forever", "-shared", "-rfbport", String(rfbPort)],
        { logPath: vncLog },
      );
      writeRecord(paneDir, { display, rfbPort, xvfbPid: xvfbChild.pid, x11vncPid: vncChild.pid });

      await this.awaitReady(displayNumber, rfbPort, d);

      const entry: DisplayEntry = {
        paneId,
        display,
        displayNumber,
        rfbPort,
        xvfbPid: xvfbChild.pid,
        x11vncPid: vncChild.pid,
        xvfbChild,
        vncChild,
        sweptAfter: d.now() + DISPLAY_CENSUS_FRESH_MS,
      };
      this.entries.set(paneId, entry);
      this.lost.delete(paneId); // a fresh display clears the old loss story
      this.watchChild(paneId, entry, "Xvfb", xvfbChild);
      this.watchChild(paneId, entry, "x11vnc", vncChild);
      this.say(`preview display ${display}: opened for pane ${paneId} (rfb 127.0.0.1:${rfbPort})`);
      return { display, rfbPort };
    } catch (err: unknown) {
      // Whatever started, none of it outlives the refusal. teardown reads only
      // the child pids, so the fields the failure never reached stay zeroed.
      this.teardown(
        {
          paneId,
          display,
          displayNumber,
          rfbPort: 0,
          xvfbPid: xvfbChild?.pid ?? 0,
          x11vncPid: vncChild?.pid ?? 0,
          sweptAfter: 0, // never registered; the census floor is not its question
        },
        paneDir,
        lockPath,
      );
      throw err;
    }
  }

  /**
   * Plane/daemon-ordered teardown of one pane's display: deregister FIRST (so
   * the child-exit watch cannot read our own kill as a loss), signal both
   * children if they still probe alive, then reap dir and lock. Synchronous
   * because its caller (the death report, the sweep) is a plain line of
   * cleanup, and an fs failure there must cost a log line, never the report.
   */
  closeFor(paneId: string): void {
    const entry = this.entries.get(paneId);
    if (entry) {
      this.entries.delete(paneId);
      this.lost.delete(paneId);
      this.teardown(entry, join(this.dataDir, "displays", paneId), this.lockPathFor(entry.displayNumber));
      return;
    }
    // Unregistered belt: a half-open launch left a dir whose lock the record
    // still names. Reap the dir and (only when the record is readable) its
    // lock; a lock with no record is the sweep's floor-guarded business.
    // The pane is being closed, so a loss marker left by its child's exit is
    // the story of a display this close ends: clear it even when the dir is
    // already gone (the watch reaped it first), or the ports arm would keep
    // answering screenLost for a pane the plane has now explicitly closed.
    this.lost.delete(paneId);
    const paneDir = join(this.dataDir, "displays", paneId);
    const rec = readRecord(paneDir);
    const displayNumber = displayNumberOf(rec?.display);
    if (!isSubshellId(paneId) || !existsSync(paneDir)) return;
    if (Number.isInteger(displayNumber) && displayNumber > 0) {
      this.teardown(
        {
          paneId,
          display: `:${displayNumber}`,
          displayNumber,
          rfbPort: 0,
          xvfbPid: intOf(rec?.xvfbPid),
          x11vncPid: intOf(rec?.x11vncPid),
          sweptAfter: 0, // belt teardown, not a registered entry
        },
        paneDir,
        this.lockPathFor(displayNumber),
      );
    } else {
      try {
        rmSync(paneDir, { recursive: true, force: true });
      } catch (err: unknown) {
        this.say(`preview display: closeFor ${paneId}: dir reap failed: ${String(err)}`);
      }
    }
  }

  /**
   * The periodic reconciliation (spec §5's "the sweep catches what a crash
   * orphaned"), run by the daemon at boot and hourly with the alive-pane
   * census - and by the daemon's wrapper ONLY on a census that completed,
   * because sweeping on a census that cannot vouch for its own completeness
   * would tear down every live display. THREE passes:
   * pass 1 works the registry: a LIVE pane's handle-less (rehydrated) entry
   * gets its recorded pids signal-0 probed, so a display that died under a
   * live pane gets the same named loss + reap the child-exit watch performs
   * for spawned children; a census-absent entry is reaped only once past its
   * fresh-entry floor (a launch can register before the census's meta scan
   * sees the row); pass 2 walks the DISK, what a daemon restart makes
   * necessary because the restart cleared the registry - a live pane's dir
   * rehydrates from `display.json` (only while `bindProbe` still answers its
   * recorded RFB port: children dead means REAP, not a record that would
   * strand the affordance forever on a dead socket), a dead pane's dir is
   * reaped, and the ssh retention's one-hour launch floor rides both,
   * because a dir from an in-flight `openFor` is not an orphan; pass 3 frees
   * aged locks no entry holds.
   */
  async sweepOrphans(alivePaneIds: string[]): Promise<DisplaySweepResult> {
    const alive = new Set(alivePaneIds);
    const d = this.deps();
    const now = d.now();
    let reaped = 0;
    let rehydrated = 0;
    let locksFreed = 0;

    for (const [paneId, entry] of [...this.entries]) {
      if (alive.has(paneId)) {
        // A rehydrated entry has no child handles, so the child-exit watch
        // cannot see its death. The signal-0 probe is the sweep's half of
        // that watch: a recorded pid that no longer exists means the display
        // died under a live pane, which gets the SAME named loss, deregister,
        // and reap the exit watch performs for the displays this daemon
        // spawned - otherwise the registry answers `screen` for a dead server
        // forever and the plane dials it with no cause to show.
        if (!entry.xvfbChild && !entry.vncChild) {
          const deadBinary = this.probeRehydratedDeath(entry);
          if (deadBinary !== null) {
            this.entries.delete(paneId);
            this.lost.set(paneId, deadBinary);
            this.say(
              `preview display ${entry.display} for pane ${paneId}: recorded ${deadBinary} pid is gone; reaped the display, pane left running`,
            );
            this.teardown(entry, join(this.dataDir, "displays", paneId), this.lockPathFor(entry.displayNumber));
            reaped += 1;
          }
        }
        continue;
      }
      // Absent from the census: only after the fresh-entry floor, because a
      // launch can register its display before the census's meta scan sees
      // the row. One minute is generous for that race and short for an orphan.
      if (now < entry.sweptAfter) continue;
      this.entries.delete(paneId);
      this.lost.delete(paneId);
      this.teardown(entry, join(this.dataDir, "displays", paneId), this.lockPathFor(entry.displayNumber));
      reaped += 1;
    }

    const root = join(this.dataDir, "displays");
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return { reaped, rehydrated, locksFreed }; // ENOENT/ENOTDIR: never any displays here
    }
    for (const name of names) {
      if (!isSubshellId(name)) continue; // our own dirs are id-named; anything else is not ours
      if (this.entries.has(name)) continue; // registered = pass 1's (or nobody's) business
      const path = join(root, name);
      try {
        const st = lstatSync(path); // never follow a symlink planted beside our layout
        if (!st.isDirectory()) continue;
        if (st.mtimeMs > now - ORPHAN_SSH_DIR_MIN_AGE_MS) continue; // launch write->meta window
        if (!(await pathAllowed(path, [this.dataDir]))) {
          this.say(`preview display sweep: refusing ${path} (outside the data dir)`);
          continue;
        }
        const rec = readRecord(path);
        const displayNumber = displayNumberOf(rec?.display);
        const paneAlive = alive.has(name);
        const childrenAnswer =
          paneAlive &&
          Number.isInteger(displayNumber) &&
          displayNumber > 0 &&
          Number.isInteger(rec?.rfbPort) &&
          (await d.bindProbe(Number(rec?.rfbPort)));
        if (childrenAnswer && rec) {
          this.entries.set(name, {
            paneId: name,
            display: `:${displayNumber}`,
            displayNumber,
            rfbPort: Number(rec.rfbPort),
            xvfbPid: intOf(rec.xvfbPid),
            x11vncPid: intOf(rec.x11vncPid),
            // No child handles: THIS process did not spawn them, so there is
            // no exit promise to watch. The sweep watches instead: pass 1
            // probes the recorded pids every pass while the pane is alive
            // (probeRehydratedDeath), and a dead one gets the same named-loss
            // teardown the exit watch performs for spawned children. The
            // census floor is the record's own age (already past it: that is
            // what made rehydration eligible), never "now".
            sweptAfter: st.mtimeMs + ORPHAN_SSH_DIR_MIN_AGE_MS,
          });
          rehydrated += 1;
          this.say(`preview display :${displayNumber}: rehydrated for live pane ${name}`);
          continue;
        }
        this.teardown(
          {
            paneId: name,
            display: Number.isInteger(displayNumber) && displayNumber > 0 ? `:${displayNumber}` : "unknown",
            displayNumber: Number.isInteger(displayNumber) ? displayNumber : 0,
            rfbPort: 0,
            xvfbPid: intOf(rec?.xvfbPid),
            x11vncPid: intOf(rec?.x11vncPid),
            sweptAfter: 0, // disk reap of an unregistered dir
          },
          path,
          Number.isInteger(displayNumber) && displayNumber > 0 ? this.lockPathFor(displayNumber) : "",
        );
        reaped += 1;
      } catch (err: unknown) {
        this.say(`preview display sweep: ${path}: ${String(err)}`); // total by construction
      }
    }

    // Orphan locks: a number no (re)registered entry holds, older than the
    // same floor, is a display that is by definition nobody's now.
    for (const name of names) {
      const m = /^\.display-(\d+)\.lock$/.exec(name);
      if (!m) continue;
      const number = Number(m[1]);
      let held = false;
      for (const e of this.entries.values()) {
        if (e.displayNumber === number) {
          held = true;
          break;
        }
      }
      if (held) continue;
      const path = join(root, name);
      try {
        const st = lstatSync(path);
        if (st.mtimeMs > now - ORPHAN_SSH_DIR_MIN_AGE_MS) continue;
        unlinkSync(path);
        locksFreed += 1;
      } catch {
        /* gone or unreadable: a lock line costs nothing */
      }
    }

    if (reaped > 0 || rehydrated > 0 || locksFreed > 0) {
      this.say(`preview display sweep: reaped ${reaped}, rehydrated ${rehydrated}, freed ${locksFreed} lock(s)`);
    }
    return { reaped, rehydrated, locksFreed };
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  private say(line: string): void {
    this.defaults.log?.(line);
  }

  private deps(over?: DisplayDeps) {
    const d = { ...this.defaults, ...stripUndefined(over) };
    return {
      spawn: d.spawn ?? bunSpawn,
      spawnSync: d.spawnSync ?? bunSpawnSync,
      which: d.which ?? bunWhich,
      sleep: d.sleep ?? realSleep,
      now: d.now ?? Date.now,
      bindProbe: d.bindProbe ?? portOccupied,
      kill:
        d.kill ??
        ((pid: number, signal: number | string = "SIGTERM") => process.kill(pid, signal as NodeJS.Signals | 0)),
      xSocketReady: d.xSocketReady ?? socketExists,
      readyBudgetMs: d.readyBudgetMs ?? DEFAULT_READY_BUDGET_MS,
    };
  }

  /** The `wx` claim loop: the kernel's exclusivity is the lock, :90..:199. */
  private claimNumber(root: string): number {
    for (let candidate = DISPLAY_MIN; candidate <= DISPLAY_MAX; candidate++) {
      const path = join(root, `.display-${candidate}.lock`);
      try {
        closeSync(openSync(path, "wx", 0o600));
        return candidate;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // someone else's number
        throw err;
      }
    }
    throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: no free display in :${DISPLAY_MIN}..:${DISPLAY_MAX}`);
  }

  /** Bind-probe upward from 5910; the first FREE port wins (a busy one is somebody's server). */
  private async chooseRfbPort(d: ReturnType<PreviewDisplays["deps"]>): Promise<number> {
    for (let port = RFB_PORT_MIN; port < RFB_PORT_MIN + RFB_PORT_PROBES; port++) {
      if (!(await d.bindProbe(port))) return port;
    }
    throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: no free rfb port from ${RFB_PORT_MIN}`);
  }

  /** X socket first (the server itself), then the RFB port answering yes. Budget, then refuse. */
  private async awaitReady(
    displayNumber: number,
    rfbPort: number,
    d: ReturnType<PreviewDisplays["deps"]>,
  ): Promise<void> {
    const start = d.now();
    for (;;) {
      if (d.xSocketReady(displayNumber) && (await d.bindProbe(rfbPort))) return;
      if (d.now() - start >= d.readyBudgetMs) {
        throw new Error(
          `${PREVIEW_DISPLAY_NOT_READY}: display :${displayNumber} / rfb ${rfbPort} not answering within ${d.readyBudgetMs}ms`,
        );
      }
      await d.sleep(READY_POLL_MS);
    }
  }

  /**
   * One child's exit watch (spec §9). The ENTRY-IDENTITY guard is the whole
   * story: `closeFor` and both sweep passes delete the entry BEFORE killing,
   * so the daemon's own teardown lands here as "not registered anymore" and
   * is exactly nothing. A death while still registered is the mid-pane loss:
   * mark, reap, say which binary, and leave the pane's terminal alone.
   */
  private watchChild(paneId: string, entry: DisplayEntry, binary: NodePreviewScreenLost, child: DisplayChild): void {
    const onDeath = (detail: string): void => {
      if (this.entries.get(paneId) !== entry) return; // deliberate teardown (or a newer display owns the pane)
      this.entries.delete(paneId);
      this.lost.set(paneId, binary);
      this.say(
        `preview display ${entry.display} for pane ${paneId}: ${binary} exited (${detail}); reaped the display, pane left running`,
      );
      this.teardown(entry, join(this.dataDir, "displays", paneId), this.lockPathFor(entry.displayNumber));
    };
    child.exited.then((code) => onDeath(`code ${code}`)).catch((err: unknown) => onDeath(`spawn error ${String(err)}`));
  }

  /** The ONE reap path: signal the children that probe alive, then dir, then lock. */
  private teardown(entry: DisplayEntry, paneDir: string, lockPath: string): void {
    this.killGuarded(entry.xvfbPid);
    this.killGuarded(entry.x11vncPid);
    try {
      rmSync(paneDir, { recursive: true, force: true });
    } catch (err: unknown) {
      this.say(`preview display: ${paneDir}: dir reap failed: ${String(err)}`);
    }
    if (!lockPath) return;
    try {
      unlinkSync(lockPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.say(`preview display: ${lockPath}: lock unlink failed: ${String(err)}`);
    }
  }

  /** Probe-then-SIGTERM: never signal a pid that is not ours to signal, never throw at a caller. */
  private killGuarded(pid: number): void {
    if (!this.probeAlive(pid)) return; // already gone (the common case on the restart reaps)
    try {
      this.deps().kill(pid, "SIGTERM");
    } catch {
      /* died mid-signal */
    }
  }

  /** Signal-0 liveness: true only for a real pid the OS still knows. Never signals anything. */
  private probeAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      this.deps().kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Which recorded child of a HANDLE-LESS (rehydrated) entry is gone, or null
   * when both still probe alive. Xvfb is checked first: when both are dead,
   * the server's own loss is the truer name for what the pane lost, and the
   * order costs nothing else.
   */
  private probeRehydratedDeath(entry: DisplayEntry): NodePreviewScreenLost | null {
    if (!this.probeAlive(entry.xvfbPid)) return "Xvfb";
    if (!this.probeAlive(entry.x11vncPid)) return "x11vnc";
    return null;
  }

  private lockPathFor(displayNumber: number): string {
    return join(this.dataDir, "displays", `.display-${displayNumber}.lock`);
  }
}

function writeRecord(dir: string, rec: Record<string, unknown>): void {
  const file = join(dir, "display.json");
  writeFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // the mode is create-only; every rewrite re-pins it
}

function readRecord(dir: string): DisplayRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "display.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as DisplayRecord) : null;
  } catch {
    return null;
  }
}

/** ":91" -> 91, anything else -> NaN (the guards downstream are Number.isInteger). */
function displayNumberOf(display: unknown): number {
  return typeof display === "string" && /^:\d+$/.test(display) ? Number(display.slice(1)) : Number.NaN;
}

function intOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function stripUndefined<T extends object>(over: T | undefined): Partial<T> {
  if (!over) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(over)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
