import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fetchCdpJson } from "./cdp-http.js";

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
export type PreviewPortRow = { proto: "tcp" | "tcp6"; port: number; pid: number };

/**
 * The display the node allocated for this pane, when it has one:
 * `PreviewDisplays.getFor` / `openFor` hand these out, and a scan carries one
 * through to the `screen` half of the ports answer. A type alias on purpose,
 * not the protocol's interface: command results serialize through
 * `Record<string, JsonValue>`, which an alias satisfies and an interface (no
 * implicit index signature) refuses.
 */
export type PreviewScreenHandle = { display: string; rfbPort: number };

/** Everything `scanPanePorts` takes; `procRoot` and `probe` are test seams. */
export interface ScanPanePortsOptions {
  /** The proc filesystem root, default `/proc`. Test-only seam: fixture trees live in temp dirs. */
  procRoot?: string;
  /** The pid tmux reports for the pane (`TmuxRunner.panePid`), the BFS root. */
  panePid: number;
  /** "Is this port CDP?" default: a loopback `GET /json/version` with a 400 ms budget. Test-only seam. */
  probe?: (port: number) => Promise<boolean>;
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
 * One pass over the proc filesystem: listeners, ppid map, fd inodes, CDP.
 *
 * Refuses `preview-ports-unsupported` on non-Linux BEFORE touching fs, and
 * `preview-ports-overcap` when the tree exceeds {@link MAX_TREE_PIDS}. A
 * vanished pid mid-walk is normal (processes die) and costs that pid's rows,
 * never the scan.
 */
export async function scanPanePorts(opts: ScanPanePortsOptions): Promise<PanePortsScan> {
  if (process.platform !== "linux") throw new Error(PREVIEW_PORTS_UNSUPPORTED);
  const procRoot = opts.procRoot ?? "/proc";
  const screen = opts.screen ?? null;

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
  let cdpPort: number | null = null;
  for (const row of ports) {
    if (await probe(row.port)) {
      cdpPort = row.port;
      break;
    }
  }
  return { ports, cdpPort, screen };
}

/**
 * The default CDP test (spec §4): does `127.0.0.1:<port>` answer
 * `GET /json/version` within 400 ms with JSON carrying a `Browser` field?
 * Loopback only — the scan runs on the node's own machine, and a listener's
 * devtools answers on loopback whatever address it was bound to. Every
 * failure shape (refused, slow, non-JSON, not CDP) answers false.
 */
async function defaultCdpProbe(port: number): Promise<boolean> {
  try {
    const body = await fetchCdpJson(`http://127.0.0.1:${port}/json/version`, AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS));
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
