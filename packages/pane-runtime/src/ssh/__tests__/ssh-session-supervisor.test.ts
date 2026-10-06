import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSIONS_PER_NODE,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import type { SshSessionHooks } from "../ssh-session-open.js";
import { type SshSessionRecord, SshSessionRecordStore } from "../ssh-session-store.js";
import { getSshSessionSupervisor, resetSshSessionSupervisorsForTests } from "../ssh-session-supervisor.js";

/**
 * The brokered-session supervisor's two DURABLE promises, unit-tested with a
 * fake ssh (the recording shim pattern this dir's helpers established - no
 * real ssh, no network):
 *
 * - **The per-node quota refuses BEFORE a spawn** (`ssh-session-supervisor.ts`
 *   cap): the 9th open on a full node answers the bare `session_quota`, and
 *   the fake ssh proves it was never even invoked - the refusal is decided
 *   with the acceptance, not after a child exists (the walkthrough measured
 *   the plane's mirror; this pins the node's own copy).
 * - **Boot reconcile + exit posture**: an `accepted`/`open` record with no
 *   live child under this process reads back `lost` (never a restart, never a
 *   claim about the destination's tmux), a live fake child's record survives
 *   the sweep, and a USER close records `closed` FIRST so the death on the
 *   way down is neither rewritten to `lost` nor reported through `onLost`.
 */

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** The hello frame the fake child prints as its first stdout bytes (broker's hello gate). */
const HELLO_BYTES = encodeSshSessionFrame({
  type: "hello",
  runtimeProtocol: SSH_RUNTIME_PROTOCOL,
  agentVersion: "9.9.9-fake",
  os: "linux",
  arch: "x64",
  capabilities: ["ssh-runtime", "callback-sock"],
  homeDir: "/home/dst",
  dataDir: "/home/dst/.local/share/subshell/runtime",
  tmuxSocket: "subshell-ssh-fake000000",
  paneCount: 0,
});

/**
 * The fake ssh: a probe (`command -v …`) answers an absolute runtime path and
 * logs `PROBE`; a serve invocation (`… runtime-serve …`) logs `SERVE`, prints
 * the hello bytes, and holds as `sleep` until the supervisor's group-kill.
 * Every spawn counts in the log, so "refused before spawn" is observable.
 */
function writeFakeSsh(dir: string): { bin: string; log: string } {
  const log = join(dir, "invocations.log");
  const hello = join(dir, "hello.bin");
  writeFileSync(hello, HELLO_BYTES);
  const script = [
    "#!/bin/sh",
    `case "$*" in`,
    `  *"command -v"*) printf 'PROBE\\n' >> '${log}'; printf '/usr/bin/subshell\\n'; exit 0 ;;`,
    `esac`,
    `case "$*" in`,
    `  *"runtime-serve"*)`,
    `    printf 'SERVE\\n' >> '${log}'`,
    `    cat '${hello}'`,
    `    exec sleep 300`,
    `    ;;`,
    `esac`,
    `exit 1`,
  ].join("\n");
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${script}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log };
}

function invocations(log: string): { probe: number; serve: number } {
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return { probe: 0, serve: 0 };
  }
  return {
    probe: text.split("\n").filter((l) => l === "PROBE").length,
    serve: text.split("\n").filter((l) => l === "SERVE").length,
  };
}

const target: SshSessionTargetWire = { alias: "sup", host: "127.0.0.1", port: 22, user: null, identityFile: null };

/** One supervisor fixture: fresh node data dir + home + fake ssh + recorded hooks. */
function mkFixture(tag: string) {
  const root = tempRoot(`sup-${tag}-`);
  const fake = writeFakeSsh(root);
  const dataDir = join(root, "nodedata");
  const homeDir = join(root, "home");
  let clock = 1_700_000_000_000;
  const lost: { exitCode: number | null; signal: string | null }[] = [];
  const hooks: SshSessionHooks = {
    emitBytes: async () => {},
    emitDiag: () => {},
    onLost: (info) => lost.push(info),
  };
  const store = new SshSessionRecordStore({ dataDir, nowMs: () => clock });
  const sup = getSshSessionSupervisor({ dataDir, homeDir, sshBin: fake.bin, nowMs: () => clock });
  return { sup, store, hooks, lost, log: fake.log, setClock: (t: number) => (clock = t) };
}

const openReq = (ref: string) => ({ ref, target, runtimeCommand: "subshell" });
const stray = (store: SshSessionRecordStore, ref: string, lifecycle: SshSessionRecord["lifecycle"]): void => {
  store.write({ ref, lifecycle, host: "127.0.0.1", port: 22, user: null, openedAtMs: 1 });
};

async function waitLive(sup: ReturnType<typeof getSshSessionSupervisor>, empty: boolean): Promise<void> {
  const t0 = Date.now();
  while ((sup.liveRefs().length === 0) !== empty) {
    if (Date.now() - t0 > 5000) throw new Error(`live map never became ${empty ? "empty" : "non-empty"}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterAll(async () => {
  resetSshSessionSupervisorsForTests();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("per-node quota (node side)", () => {
  test("the open past SSH_SESSIONS_PER_NODE refuses session_quota without ever invoking ssh", async () => {
    const f = mkFixture("quota");
    const refs: string[] = [];
    try {
      for (let i = 0; i < SSH_SESSIONS_PER_NODE; i++) {
        const ref = crypto.randomUUID();
        const out = await f.sup.open(openReq(ref), f.hooks);
        expect(out.kind, `open ${i + 1} fits under the cap`).toBe("open");
        if (out.kind === "open") {
          expect(out.result.hello.runtimeProtocol).toBe(SSH_RUNTIME_PROTOCOL);
          expect(out.result.host).toBe("127.0.0.1");
        }
        refs.push(ref);
      }
      expect(f.sup.liveRefs().length).toBe(SSH_SESSIONS_PER_NODE);
      const denied = await f.sup.open(openReq(crypto.randomUUID()), f.hooks);
      expect(denied).toEqual({ kind: "refused", code: "session_quota" }); // the bare equality-mapped code the plane maps
      // Refused BEFORE a spawn: the fake ssh was invoked for exactly the 8
      // accepted opens (one probe + one serve each), nothing for the 9th.
      expect(invocations(f.log)).toEqual({ probe: SSH_SESSIONS_PER_NODE, serve: SSH_SESSIONS_PER_NODE });
      // And nothing durable was accepted for the refused ref (no stray
      // `accepted` record that the next boot would read back as `lost`).
      expect(f.sup.reconcileAtBoot()).toEqual([]);
    } finally {
      for (const ref of refs) f.sup.close(ref);
      await waitLive(f.sup, true);
    }
  });
});

describe("boot reconcile and exit posture", () => {
  test("stray accepted/open records read back lost; closed and lost are history, left alone", () => {
    const f = mkFixture("reconcile");
    stray(f.store, "a1", "accepted");
    stray(f.store, "o1", "open");
    stray(f.store, "c1", "closed");
    stray(f.store, "l1", "lost");
    f.setClock(2_000);

    const swept = f.sup.reconcileAtBoot();
    expect(swept.map((r) => r.ref).sort()).toEqual(["a1", "o1"]);
    expect(f.store.read(f.store.path("a1"))?.lifecycle).toBe("lost");
    expect(f.store.read(f.store.path("a1"))?.lostAtMs).toBe(2_000); // the injectable clock rode the sweep
    expect(f.store.read(f.store.path("o1"))?.lifecycle).toBe("lost");
    expect(f.store.read(f.store.path("c1"))?.lifecycle).toBe("closed");
    expect(f.store.read(f.store.path("c1"))?.lostAtMs).toBeUndefined();
    expect(f.store.read(f.store.path("l1"))?.lifecycle).toBe("lost");
    // Idempotent: a second sweep finds nothing (the lost terminal state is final).
    expect(f.sup.reconcileAtBoot()).toEqual([]);
  });

  test("the constructor reconciles before any open can run", () => {
    const root = tempRoot("sup-boot-");
    const fake = writeFakeSsh(root);
    const dataDir = join(root, "nodedata");
    const store = new SshSessionRecordStore({ dataDir, nowMs: Date.now });
    const ref = crypto.randomUUID();
    store.write({ ref, lifecycle: "accepted", host: "h", port: 22, user: null, openedAtMs: 1 }); // last daemon's crash-between
    const sup = getSshSessionSupervisor({ dataDir, homeDir: join(root, "home"), sshBin: fake.bin, nowMs: Date.now });
    expect(sup.liveRefs()).toEqual([]);
    expect(store.read(store.path(ref))?.lifecycle).toBe("lost");
    expect(sup.reconcileAtBoot()).toEqual([]); // the build-time sweep already took it
  });

  test("a live child's record survives the sweep, and a close records closed BEFORE the death", async () => {
    const f = mkFixture("exit");
    const ref = crypto.randomUUID();
    try {
      const out = await f.sup.open(openReq(ref), f.hooks);
      expect(out.kind).toBe("open");
      expect(f.store.read(f.store.path(ref))?.lifecycle).toBe("open");
      stray(f.store, "stray1", "accepted");

      // The sweep with a REAL live child: only the stranger is swept; the
      // child's `open` record is untouched (live map is authority, not disk).
      const swept = f.sup.reconcileAtBoot();
      expect(swept.map((r) => r.ref)).toEqual(["stray1"]);
      expect(f.store.read(f.store.path(ref))?.lifecycle).toBe("open");

      // The user close: `closed` lands FIRST, so the SIGTERM death on the way
      // down is neither rewritten to `lost` nor reported as a loss.
      expect(f.sup.close(ref)).toBe("ok");
      expect(f.store.read(f.store.path(ref))?.lifecycle).toBe("closed");
      await waitLive(f.sup, true);
      await new Promise((r) => setTimeout(r, 50)); // let the exit pump finish its last write
      expect(f.store.read(f.store.path(ref))?.lifecycle).toBe("closed");
      expect(f.lost, "a close is not a loss (the stopping latch)").toEqual([]);
    } finally {
      f.sup.close(ref); // idempotent if the child already died
      await waitLive(f.sup, true);
    }
  });
});
