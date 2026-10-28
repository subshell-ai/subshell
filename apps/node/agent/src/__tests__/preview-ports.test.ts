import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodePreviewPortsResult } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execPreviewPorts, PREVIEW_NODE_OFF, type PreviewPortsSeams } from "../commands/preview-ports-exec.js";
import { setPreviewEnabled } from "../preview/flags.js";
import type { ScanPanePortsOptions } from "../preview/ports.js";
import { scanPanePorts } from "../preview/ports.js";

/**
 * Pane port discovery (pane-preview spec §4/§5, Task 4): the scanner walks a
 * fixture `/proc` in a temp dir, and the executor arms answer through the
 * dispatch switch. Posture copied from commands-ssh-relay.test.ts: real temp
 * dirs, the preview mirror written by its own writer, refusals asserted by
 * `ok:false` + exact message.
 *
 * THREE fixture roots, and one shared root cannot serve all five scan tests:
 * `tinyProcRoot` holds exactly ONE attributed LISTEN (test 1's exact-list
 * assertion needs a root nothing else is in); `procRoot` is the full fixture
 * (the 3000 row, an attributed 9222 for the CDP probe, an attributed tcp6
 * 4321, and outsider 8080 owned by a pid OUTSIDE the pane tree);
 * `emptyProcRoot` has no listeners. An attributed 9222 or 4321 in a shared
 * root would break test 1's `toEqual`, and a root without them makes tests 2
 * and 5 unanswerable.
 *
 * The scanner tests are Linux-gated (spec §12: "fixture /proc trees
 * (inject the reader, Linux-gated test)") — the scanner itself refuses any
 * other platform before touching fs, so on macOS the walk cannot be
 * exercised at all. The executor tests run everywhere: every path they take
 * stops before the scan (gate, dead pane) or injects the scan seam.
 */

const STAMP = "2026-10-21T10:00:00.000Z";
const PANE = "11111111-2222-4333-8444-555555555555";
const PREVIEW_OFF_REFUSAL = "preview-node-off: turn on Preview for this node";
const PANE_GONE_REFUSAL = "preview-ports-pane-gone";

let base: string;
let procRoot: string;
let tinyProcRoot: string;
let emptyProcRoot: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-preview-ports-")));
  // procRoot: the full fixture. Tree 100 → 101 → 102; outsider 999 hangs off
  // pid 500, outside the pane tree. 102 owns the LISTENs the tests expect;
  // 999 owns 8080, which must never appear.
  procRoot = join(base, "proc");
  mkdirSync(join(procRoot, "net"), { recursive: true });
  mkPidTree(procRoot, [
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    {
      pid: 102,
      ppid: 101,
      fds: [
        { name: "3", inode: 300_001 },
        { name: "5", inode: 300_002 },
        { name: "6", inode: 300_004 },
      ],
    },
    { pid: 999, ppid: 500, fds: [{ name: "3", inode: 300_003 }] },
  ]);
  writeNet(join(procRoot, "net", "tcp"), [
    { addr: "0100007F", port: 3000, inode: 300_001 },
    { addr: "0100007F", port: 9222, inode: 300_002 },
    { addr: "00000000", port: 8080, inode: 300_003 },
  ]);
  writeNet(join(procRoot, "net", "tcp6"), [{ addr: "00000000000000000000000001000000", port: 4321, inode: 300_004 }]);

  // tinyProcRoot: exactly ONE attributed LISTEN, and TWO tree members own the
  // same socket inode (the 101 link is the inherited fd): the answer must be
  // the deepest descendant, 102.
  tinyProcRoot = join(base, "tiny-proc");
  mkdirSync(join(tinyProcRoot, "net"), { recursive: true });
  mkPidTree(tinyProcRoot, [
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100, fds: [{ name: "3", inode: 5001 }] },
    { pid: 102, ppid: 101, fds: [{ name: "4", inode: 5001 }] },
  ]);
  writeNet(join(tinyProcRoot, "net", "tcp"), [{ addr: "0100007F", port: 3000, inode: 5001 }]);
  writeNet(join(tinyProcRoot, "net", "tcp6"), []);

  // emptyProcRoot: a live tree that simply listens on nothing.
  emptyProcRoot = join(base, "empty-proc");
  mkdirSync(join(emptyProcRoot, "net"), { recursive: true });
  mkPidTree(emptyProcRoot, [{ pid: 100, ppid: 1 }]);
  writeNet(join(emptyProcRoot, "net", "tcp"), []);
  writeNet(join(emptyProcRoot, "net", "tcp6"), []);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Write one `<pid>/` dir: `stat` (ppid at its real column), `cmdline`, and the fd symlinks. */
function mkPidTree(root: string, pids: { pid: number; ppid: number; fds?: { name: string; inode: number }[] }[]): void {
  for (const p of pids) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir, { recursive: true });
    // The comm field carries a space on purpose: a parser that splits the
    // whole line on whitespace reads the wrong column as ppid on every real
    // host whose process names contain spaces or parens.
    writeFileSync(
      `${dir}/stat`,
      `${p.pid} (proc ${p.pid}) S ${p.ppid} ${p.pid} ${p.pid} 0 0 0 0 20 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    );
    writeFileSync(`${dir}/cmdline`, `proc-${p.pid}\0--flag\0`);
    if (p.fds) {
      mkdirSync(`${dir}/fd`);
      for (const fd of p.fds) symlinkSync(`socket:[${fd.inode}]`, join(dir, "fd", fd.name));
    }
  }
}

/**
 * Write a `/proc/net/tcp`-shaped file (the tcp6 twin differs only in the
 * width of the address the caller passes): header plus LISTEN (state 0A)
 * rows, the inode in its real column.
 */
function writeNet(file: string, rows: { addr: string; port: number; inode: number }[]): void {
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const lines = rows.map(
    (r, i) =>
      `   ${i}: ${r.addr}:${r.port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${r.inode} 1 0 1 0 -1`,
  );
  writeFileSync(file, `${[header, ...lines].join("\n")}\n`);
}

describe.skipIf(process.platform !== "linux")("scanPanePorts over fixture /proc trees", () => {
  it("attributes a listening socket to the deepest descendant that owns it", async () => {
    const r = await scanPanePorts({
      procRoot: tinyProcRoot,
      panePid: 100,
      websiteProbe: async () => ({}),
      probe: async () => false,
    });
    expect(r.ports).toEqual([{ proto: "tcp", port: 3000, pid: 102 }]);
  });

  it("lists only websites while retaining CDP separately", async () => {
    const r = await scanPanePorts({
      procRoot,
      panePid: 100,
      probe: async (port) => port === 9222,
      websiteProbe: async (port) => (port === 3000 ? { title: "My app" } : null),
    });
    expect(r.ports).toEqual([{ proto: "tcp", port: 3000, pid: 102, title: "My app" }]);
    expect(r.cdpPort).toBe(9222);
  });

  it("cdpPort is the LISTEN port whose /json/version probe answers", async () => {
    const r = await scanPanePorts({
      procRoot,
      panePid: 100,
      websiteProbe: async () => ({}),
      probe: async (p) => p === 9222,
    });
    expect(r.cdpPort).toBe(9222);
  });

  it("a socket owned by an outsider never appears", async () => {
    const r = await scanPanePorts({ procRoot, panePid: 100, websiteProbe: async () => ({}), probe: async () => false });
    expect(r.ports.some((p) => p.port === 8080)).toBe(false);
  });

  it("no listeners answers with empty arrays, not an error", async () => {
    const r = await scanPanePorts({
      procRoot: emptyProcRoot,
      panePid: 100,
      websiteProbe: async () => ({}),
      probe: async () => false,
    });
    expect(r.ports).toEqual([]);
    expect(r.cdpPort).toBeNull();
    expect(r.screen).toBeNull();
  });

  it("an IPv6 loopback listener parses", async () => {
    const r = await scanPanePorts({ procRoot, panePid: 100, websiteProbe: async () => ({}), probe: async () => false });
    expect(r.ports).toContainEqual({ proto: "tcp6", port: 4321, pid: 102 });
  });

  it("a tree of hang-prone listeners does not starve the real website", async () => {
    // The shape this pins: a port the scan never reached reads exactly like a
    // port that is not a website, so the probe budget has to grow with the
    // number of listeners. Sixteen sockets that accept and never answer (a
    // language server, a leftover bind), each costing the worst-case probe
    // time, with the dev server LAST in the row order: too small a budget
    // leaves the picker saying this pane serves no website at all.
    const crowdRoot = join(base, "crowd-proc");
    mkdirSync(join(crowdRoot, "net"), { recursive: true });
    const WEBSITE_PORT = 4500;
    const rows = [...Array.from({ length: 16 }, (_, i) => 4001 + i), WEBSITE_PORT].map((port, i) => ({
      addr: "0100007F",
      port,
      inode: 700_001 + i,
    }));
    mkPidTree(crowdRoot, [
      { pid: 100, ppid: 1 },
      { pid: 102, ppid: 100, fds: rows.map((row, i) => ({ name: String(3 + i), inode: row.inode })) },
    ]);
    writeNet(join(crowdRoot, "net", "tcp"), rows);
    writeNet(join(crowdRoot, "net", "tcp6"), []);
    // The two budgets the real probes carry, in the order they run: devtools
    // first, then the document probe for anything that did not answer it.
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const started = Date.now();
    const r = await scanPanePorts({
      procRoot: crowdRoot,
      panePid: 100,
      probe: async () => {
        await wait(280);
        return false;
      },
      websiteProbe: async (port) => {
        if (port !== WEBSITE_PORT) await wait(420);
        return port === WEBSITE_PORT ? { title: "Dev server" } : null;
      },
    });
    expect(r.ports).toEqual([{ proto: "tcp", port: WEBSITE_PORT, pid: 102, title: "Dev server" }]);
    // And it got there without leaning on the ceiling: the scan must stay far
    // inside the plane's 10 s command timeout, or a slow pane answers nothing.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("a process tree past 512 pids refuses preview-ports-overcap", async () => {
    // A linear chain of 600 descendants: the walk must refuse rather than
    // readlink its way through a fork bomb.
    const capRoot = join(base, "cap-proc");
    mkdirSync(join(capRoot, "net"), { recursive: true });
    const pids: { pid: number; ppid: number }[] = [{ pid: 1000, ppid: 1 }];
    for (let pid = 1001; pid < 1600; pid++) pids.push({ pid, ppid: pid - 1 });
    mkPidTree(capRoot, pids);
    writeNet(join(capRoot, "net", "tcp"), []);
    writeNet(join(capRoot, "net", "tcp6"), []);
    await expect(
      scanPanePorts({ procRoot: capRoot, panePid: 1000, websiteProbe: async () => ({}), probe: async () => false }),
    ).rejects.toThrow("preview-ports-overcap");
  });

  it("the screen handle rides through the scan untouched", async () => {
    const r = await scanPanePorts({
      procRoot,
      panePid: 100,
      websiteProbe: async () => ({}),
      probe: async () => false,
      screen: { display: ":97", viewer: { protocol: "vnc", port: 5900 } },
    });
    expect(r.screen).toEqual({ display: ":97", viewer: { protocol: "vnc", port: 5900 } });
  });
});

it.skipIf(process.platform === "linux")(
  "scanPanePorts refuses preview-ports-unsupported on non-Linux, before touching fs",
  async () => {
    // The procRoot names nothing: the refusal must arrive without a single
    // fs read, so a bad-path root cannot tell the refusal apart from an
    // ENOENT.
    await expect(
      scanPanePorts({
        procRoot: join(base, "no-such-proc"),
        panePid: 1,
        websiteProbe: async () => ({}),
        probe: async () => false,
      }),
    ).rejects.toThrow("preview-ports-unsupported");
  },
);

describe("the preview_ports_get executor", () => {
  function makeCtx(tag: string, opts: { previewOn?: boolean; panePid?: number | null } = {}) {
    const dataDir = join(base, tag, "data");
    mkdirSync(dataDir, { recursive: true });
    if (opts.previewOn ?? false) setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    const ctx = {
      config: { dataDir, nodeId: "node-self" },
      meta: { get: async () => undefined },
      tmux: { panePid: async () => (opts.panePid === undefined ? 100 : opts.panePid) },
    } as unknown as CommandContext;
    return ctx;
  }

  it("an off switch refuses preview-node-off naming the remedy, via the dispatch switch", async () => {
    const ctx = makeCtx("gate-off");
    const res = await dispatchCommand(ctx, { type: "preview_ports_get", paneId: PANE });
    expect(res).toEqual({ ok: false, error: PREVIEW_OFF_REFUSAL });
    // The word AND the remedy, and the arm exists (an unwired switch answers
    // `unsupported`, never this sentence).
    expect(PREVIEW_NODE_OFF).toBe(PREVIEW_OFF_REFUSAL);
    expect(PREVIEW_NODE_OFF).toContain("preview-node-off");
    expect(PREVIEW_NODE_OFF).toContain("turn on Preview for this node");
  });

  it("a dead pane refuses preview-ports-pane-gone", async () => {
    const ctx = makeCtx("dead-pane", { previewOn: true, panePid: null });
    const res = await dispatchCommand(ctx, { type: "preview_ports_get", paneId: PANE });
    expect(res).toEqual({ ok: false, error: PANE_GONE_REFUSAL });
  });

  it("a malformed pane id refuses invalid subshell id before any tmux touch", async () => {
    const ctx = makeCtx("bad-id", { previewOn: true, panePid: null });
    // panePid null would answer pane-gone: the id answer proves the gate ran
    // first and tmux was never reached.
    const res = await dispatchCommand(ctx, { type: "preview_ports_get", paneId: "nope/" });
    expect(res).toEqual({ ok: false, error: "invalid subshell id" });
  });

  it("a successful answer is the scan output, screen null, and passes the Task 1 validator", async () => {
    const ctx = makeCtx("success", { previewOn: true, panePid: 100 });
    const seen: ScanPanePortsOptions[] = [];
    const seams: PreviewPortsSeams = {
      scan: async (opts) => {
        seen.push(opts);
        return {
          ports: [{ proto: "tcp", port: 3000, pid: 102 }],
          cdpPort: 9222,
          screen: opts.screen ?? null,
        };
      },
    };
    const res = await execPreviewPorts(ctx, { type: "preview_ports_get", paneId: PANE }, seams);
    expect(res.ok).toBe(true);
    if (!res.ok) return; // type narrowing; unreachable
    // The executor's answer is the scan's result plus the screen it passed
    // in, and this task hardwires that screen to null (Task 7's registry
    // amends the arm).
    expect(seen.length).toBe(1);
    expect(seen[0]?.panePid).toBe(100);
    expect(seen[0]?.screen).toBeNull();
    // The shape is contract, not vibes: Task 1's validator must accept it.
    const parsed = parseNodePreviewPortsResult(res.data);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ ports: [{ proto: "tcp", port: 3000, pid: 102 }], cdpPort: 9222, screen: null });
  });
});
