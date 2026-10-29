import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fetchCdpJsonFromLoopback } from "./cdp-http.js";
import type { PreviewScreenHandle } from "./display-provider.js";
import { probeWebsite, type WebsiteInfo } from "./website-probe.js";

/**
 * Pane port discovery (pane-preview spec §4/§5, Task 4): what the pane's
 * process tree is listening on, found by ONE STATELESS PASS over `/proc` —
 * no cache, no watcher, nothing to reconcile after the fact. The pass reads
 * the kernel's two listener tables, the ppid edge of every process, and the
 * socket inodes held open by each fd, and joins them: a LISTEN row is the
 * pane's when the inode it names is open in a process under the pane's root,
 * attributed to the DEEPEST such descendant (an inherited fd in the pane's
 * shell must not steal the socket from the server that owns it now).
 *
 * `procRoot` and `probe` exist only for tests: the fixture `/proc` is a temp
 * dir, and no test should open real sockets to fake a devtools answer. The
 * real scan reads `/proc` on the box the pane runs on.
 */

/** One listening socket of the pane's tree, as the wire row names it. */
export type PreviewPortRow = { proto: "tcp" | "tcp6"; port: number; pid: number; title?: string };

/** Everything `scanPanePorts` takes; `procRoot` and `probe` are test seams. */
export interface ScanPanePortsOptions {
  /** The proc filesystem root, default `/proc`. Test-only seam: fixture trees live in temp dirs. */
  procRoot?: string;
  /** The pid tmux reports for the pane (`TmuxRunner.panePid`), the BFS root. */
  panePid: number;
  /**
   * "Is this port CDP?" default: a loopback `GET /json/version` with a 400 ms
   * budget per family. The second argument is the scan's deadline: a probe that
   * outlives it costs the whole command its answer, so it must stop when told.
   * Test-only seam.
   */
  probe?: (port: number, signal: AbortSignal) => Promise<boolean>;
  /** Test seam for the bounded HTML document probe. */
  websiteProbe?: (port: number, signal: AbortSignal) => Promise<WebsiteInfo | null>;
  /** The pane's allocated display, passed through to the answer; null means this pane has none. */
  screen?: PreviewScreenHandle | null;
}

/** The one-pass answer: rows, the CDP port if a listed one answered, and the passed-in screen. */
export interface PanePortsScan {
  ports: PreviewPortRow[];
  cdpPort: number | null;
  screen: PreviewScreenHandle | null;
}

/** Non-Linux has no `/proc` walk to run; the refusal is named, never a guess. */
export const PREVIEW_PORTS_UNSUPPORTED = "preview-ports-unsupported";

/** The pane's tree outgrew the walk budget; refuse rather than readlink an unbounded fork bomb. */
export const PREVIEW_PORTS_OVERCAP = "preview-ports-overcap";

/** The refusal's number: total pids (the pane root included) the BFS may visit. */
const MAX_TREE_PIDS = 512;

/** The CDP probe's budget, spec §4. */
const CDP_PROBE_TIMEOUT_MS = 400;

/**
 * Ports probed at once. Loopback probes are cheap and mostly wait on a peer,
 * so a queue is what makes a scan slow rather than what it costs the host, and
 * this is the number that decides how many stalled listeners a pane can hold
 * before the scan's ceiling starts dropping ports.
 */
const SCAN_PROBE_WORKERS = 32;

/**
 * Where the previous scan's budget ran out. The kernel lists listeners in a
 * stable order, so always draining from index 0 makes starvation permanent: the
 * same leading stalled sockets eat the budget on every poll and the tail is never
 * reached. Each scan starts one further along, so every port gets asked within a
 * few polls.
 */
let probeCursor = 0;

/**
 * The scan's wall-clock budget, counted from the moment it is entered so the
 * synchronous /proc pass is part of it: a floor for the probes, what each
 * candidate may add, and a ceiling for the whole pass.
 */
const SCAN_DEADLINE_BASE_MS = 2_500;
const SCAN_DEADLINE_PER_PORT_MS = 250;
const SCAN_DEADLINE_MAX_MS = 6_000;
/** Never let a slow walk leave the probes no time at all: this is their floor. */
const SCAN_PROBE_MIN_MS = 1_500;
/**
 * What the whole pass may cost. The plane gives a node command
 * `DEFAULT_COMMAND_TIMEOUT_MS` (10 s, `node-rpc.ts`) and a scan that overruns it
 * answers NOTHING, which is worse than dropping a tail the next poll rotates
 * into. The spare second is the answer's own trip back, because the clock that
 * matters starts when the command is sent, not when the walk began. The floor is
 * a floor on the probes, never a floor on the total: after a walk slow enough to
 * eat the budget, probes get nothing and the scan returns what the tables say
 * with no rows, quickly, rather than dying on the timeout.
 */
const SCAN_COMMAND_LIMIT_MS = 9_000;

/**
 * How long the probe pass may run, given what the walk already took. Pure and
 * exported so the arithmetic is checkable without a loaded host: the window is
 * the smallest of the candidate-sized allowance, what remains under the ceiling
 * (never below the floor), and what remains under the command limit.
 */
export function probeWindowMs(elapsedMs: number, candidateCount: number): number {
  const sized = SCAN_DEADLINE_BASE_MS + SCAN_DEADLINE_PER_PORT_MS * candidateCount;
  const floored = Math.max(SCAN_PROBE_MIN_MS, SCAN_DEADLINE_MAX_MS - elapsedMs);
  return Math.max(0, Math.min(sized, floored, SCAN_COMMAND_LIMIT_MS - elapsedMs));
}

/**
 * One pass over the proc filesystem: listeners, ppid map, fd inodes, CDP.
 *
 * Refuses `preview-ports-unsupported` on non-Linux BEFORE touching fs, and
 * `preview-ports-overcap` when the tree exceeds {@link MAX_TREE_PIDS}. A
 * vanished pid mid-walk is normal (processes die) and costs that pid's rows,
 * never the scan.
 */
export async function scanPanePorts(opts: ScanPanePortsOptions): Promise<PanePortsScan> {
  if (process.platform !== "linux") {
    // Provider-owned displays do not depend on Linux process-tree discovery.
    if (opts.screen) return { ports: [], cdpPort: null, screen: opts.screen };
    throw new Error(PREVIEW_PORTS_UNSUPPORTED);
  }
  const procRoot = opts.procRoot ?? "/proc";
  const screen = opts.screen ?? null;

  // Measured from entry, so the /proc pass counts against the probe budget
  // rather than being free time in front of it: on a loaded host the reads and
  // readlinks across up to MAX_TREE_PIDS pids take seconds of their own, and a
  // deadline that began afterwards could push the whole answer past the plane's
  // command timeout, which is the failure this budget exists to avoid. It is a
  // timestamp and not a signal, because the walk is synchronous and nothing
  // could interrupt it; a signal started here could expire before a single port
  // is probed and answer "no websites" for a pane with one perfect dev server.
  const startedAt = Date.now();

  const listeners = [
    ...readListenRows(join(procRoot, "net", "tcp"), "tcp"),
    ...readListenRows(join(procRoot, "net", "tcp6"), "tcp6"),
  ];
  const owners = socketOwners(procRoot, buildPpidMap(procRoot), opts.panePid);

  const ports: PreviewPortRow[] = [];
  const seenInodes = new Set<number>();
  for (const row of listeners) {
    const owner = owners.get(row.inode);
    if (owner === undefined || seenInodes.has(row.inode)) continue;
    // The SAME socket can appear on two rows - a dual-stack IPv6 socket
    // bound to `::` is listed in both the v4 and v6 tables, one inode read
    // twice - and the wire lists one row per listening SOCKET, so the inode
    // dedups it. (Two real binds on two addresses are two sockets with two
    // inodes and stay two rows, as they should.)
    seenInodes.add(row.inode);
    ports.push({ proto: row.proto, port: row.port, pid: owner });
  }

  const probe = opts.probe ?? defaultCdpProbe;
  const website = opts.websiteProbe ?? probeWebsite;
  const candidates = [...new Set(ports.map((row) => row.port))];
  const websites = new Map<number, WebsiteInfo>();
  const cdpPorts = new Set<number>();
  // Two probes per port, asked at the SAME time and both bounded by the scan's
  // deadline. In series a listener that accepts and never answers costs the
  // devtools window plus the document window, and a pane holding dozens of them
  // outruns any budget; in parallel a port costs whichever window is longer. CDP
  // wins when both answer, so a devtools endpoint that serves its JSON listing
  // as HTML never becomes a website row. The deadline has to reach both: a probe
  // that answers only to its own timer keeps a worker running after the window
  // closes, and that overrun is what would push the command past the plane.
  //
  // The window itself comes from probeWindowMs: the candidate-sized allowance,
  // what remains of the scan's ceiling (floored, so a slow walk still asks), and
  // what remains of the plane's command budget. Being cut off is a better answer
  // than being timed out, because a command the plane abandons answers NOTHING
  // while a cut-off scan simply leaves a tail untried, and an untried port reads
  // like a port that is not a website only until the next poll, seconds later,
  // rotates the start point onto it.
  const windowMs = probeWindowMs(Date.now() - startedAt, candidates.length);
  // Rotating start point: see probeCursor. Wrapping means the ports this scan
  // cannot reach before the budget runs out are the first ones the next asks.
  const start = candidates.length > 0 ? probeCursor++ % candidates.length : 0;
  let next = 0;
  if (windowMs > 0) {
    const deadline = AbortSignal.timeout(windowMs);
    await Promise.all(
      Array.from({ length: Math.min(SCAN_PROBE_WORKERS, candidates.length) }, async () => {
        while (next < candidates.length && !deadline.aborted) {
          const port = candidates[(start + next++) % candidates.length];
          if (port === screen?.viewer.port) continue;
          const [isCdp, info] = await Promise.all([probe(port, deadline), website(port, deadline)]);
          if (isCdp) cdpPorts.add(port);
          else if (info) websites.set(port, info);
        }
      }),
    );
  }
  const cdpPort = candidates.find((port) => cdpPorts.has(port)) ?? null;
  return {
    ports: ports.filter((row) => websites.has(row.port)).map((row) => ({ ...row, ...websites.get(row.port) })),
    cdpPort,
    screen,
  };
}

/**
 * The default CDP test (spec §4): does `<loopback>:<port>` answer
 * `GET /json/version` within 400 ms with JSON carrying a `Browser` field?
 * Loopback only — the scan runs on the node's own machine, and a listener's
 * devtools answers on loopback whatever address it was bound to. Each family
 * gets its own 400 ms slice (see `fetchCdpJsonFromLoopback`), because a browser
 * bound to `::1` only is routine and a single-family probe reported it as a
 * website with no browser to watch, and the scan's deadline rides along so a
 * worker that picked this port at the very end of the window cannot keep the
 * whole command past it. Every failure shape on every family (refused, slow,
 * non-JSON, not CDP, out of budget) answers false.
 *
 * Exported so the slice each family is given stays checkable without a live
 * browser; production reaches it only as scanPanePorts' default probe.
 */
export async function defaultCdpProbe(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const body = await fetchCdpJsonFromLoopback(port, "/json/version", signal, {
      perFamilyTimeoutMs: CDP_PROBE_TIMEOUT_MS,
      accept: (body) => typeof body === "object" && body !== null && "Browser" in body,
    });
    return typeof body === "object" && body !== null && "Browser" in body;
  } catch {
    return false;
  }
}

/** One LISTEN row of a net table. */
type ListenRow = { proto: "tcp" | "tcp6"; port: number; inode: number };

/**
 * Parse the state-0A (LISTEN) rows of a `net/tcp`/`net/tcp6` table.
 * Columns: `sl`, `local_address` (`HEXADDR:HEXPORT`), `rem_address`, `st`,
 * the tx/rx queue pair, the timer pair, `retrnsmt`, `uid`, `timeout`,
 * `inode` — the join key the fd walk matches. The header row answers
 * `st` where a hex state belongs and is skipped, as is any row whose port
 * or inode does not parse (a kernel writing a shape we cannot read is
 * answered by ignoring that row, not by refusing the scan).
 */
function readListenRows(file: string, proto: "tcp" | "tcp6"): ListenRow[] {
  const rows: ListenRow[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`preview-ports: cannot read ${file}`);
  }
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [addr, portHex] = (fields[1] ?? "").split(":");
    const port = portHex === undefined ? Number.NaN : parseInt(portHex, 16);
    const inode = Number(fields[9]);
    if (!addr || !Number.isInteger(port) || port < 1 || !Number.isInteger(inode) || inode <= 0) continue;
    rows.push({ proto, port, inode });
  }
  return rows;
}

/**
 * pid → ppid for every numeric dir in the proc root. `<pid>/stat` field 2
 * (comm) may contain spaces and parens, so the ppid (field 4) is read from
 * the tail after the LAST `)`, never by counting whitespace from column 0.
 * A pid that vanishes mid-walk is simply not in the map.
 */
function buildPpidMap(procRoot: string): Map<number, number> {
  const map = new Map<number, number>();
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    throw new Error(`preview-ports: cannot read ${procRoot}`);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try {
      stat = readFileSync(join(procRoot, name, "stat"), "utf8");
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const afterComm = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const ppid = Number(afterComm[1]); // [0] is state, [1] is ppid
    if (Number.isInteger(ppid) && ppid >= 0) map.set(pid, ppid);
  }
  return map;
}

/**
 * Inode → owning pid for every socket fd open in the pane's tree: BFS the
 * descendants of `panePid` (itself included) over the ppid map, readlink
 * each `fd/*`, keep the last match at the GREATEST depth. The BFS refuses
 * `preview-ports-overcap` past {@link MAX_TREE_PIDS} pids — a pane's tree
 * legitimately numbers in the dozens, and five hundred means a fork bomb
 * this walk will not follow.
 */
function socketOwners(procRoot: string, ppid: Map<number, number>, panePid: number): Map<number, number> {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of ppid) {
    const list = children.get(parent);
    if (list) list.push(pid);
    else children.set(parent, [pid]);
  }
  const depth = new Map<number, number>([[panePid, 0]]);
  const queue = [panePid];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i] as number;
    for (const child of children.get(parent) ?? []) {
      if (depth.has(child)) continue; // reparented loop guard; BFS never revisits
      if (depth.size + 1 > MAX_TREE_PIDS) throw new Error(PREVIEW_PORTS_OVERCAP);
      depth.set(child, (depth.get(parent) ?? 0) + 1);
      queue.push(child);
    }
  }

  const owners = new Map<number, number>();
  const ownerDepth = new Map<number, number>();
  for (const [pid, d] of depth) {
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, String(pid), "fd"));
    } catch {
      continue; // no fd table readable for a pid that just died
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(join(procRoot, String(pid), "fd", fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (!m) continue;
      const inode = Number(m[1]);
      if (d > (ownerDepth.get(inode) ?? -1)) {
        owners.set(inode, pid);
        ownerDepth.set(inode, d);
      }
    }
  }
  return owners;
}
