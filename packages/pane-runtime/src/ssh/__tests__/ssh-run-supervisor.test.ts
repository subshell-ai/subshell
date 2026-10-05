import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
  SSH_ACTIVE_RUNS_PER_NODE,
  SSH_RUN_OUTPUT_RETENTION_BYTES,
} from "@internal/subshell-protocol";
import { acceptRun, listRunIds, openRunStreamAppend, readRun, writeRunState } from "../ssh-run-store.js";
import {
  getSshRunSupervisor,
  peekSshRunSupervisor,
  resetSshSupervisorsForTests,
  SshRunSupervisor,
} from "../ssh-run-supervisor.js";
import { cleanup, makeDigest, makeRunId, shimArgs, shimLog, tempRoot, writeSshShim } from "./helpers.js";

/**
 * The supervised run engine, driven against SCRIPTED SSH SHIMS (brief: "a
 * recording shim for policy flags asserted on every invocation,
 * dedup/replay, cancel grace, output bound + drain + truncation"). The shim
 * is argv[0] for everything here, so what the supervisor actually spawns and
 * actually records is the unit under test, byte for byte.
 */

let root: string;

beforeAll(() => (root = tempRoot("subshell-ssh-sup-")));
afterAll(() => {
  resetSshSupervisorsForTests();
  cleanup(root);
});

function fixture(name: string, shimOpts: Parameters<typeof writeSshShim>[1]) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const shim = writeSshShim(join(dir, "bin"), shimOpts);
  const sup = new SshRunSupervisor({ dataDir, homeDir: dir, sshBin: shim.bin });
  return { dir, dataDir, sup, shim };
}

const baseReq = (n: number, command = "echo hi") => ({
  runId: makeRunId(n),
  requestDigest: makeDigest(`req-${n}`),
  snapshot: {
    alias: "x-host",
    host: "target.example",
    user: "ops",
    port: 2202,
    identityFiles: ["/home/ops/.ssh/id_ed25519"],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: ["/home/ops/.ssh/known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
  },
  remoteDir: "/srv/app",
  command,
  deadlineMs: 20_000,
});

async function waitFor(check: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

describe("the argv and the config it runs against", () => {
  it("spawns -F at the run's OWN rendered config, destination args, and the command as one element", async () => {
    const { sup, dataDir, shim } = fixture("argv", {});
    const req = baseReq(1);
    const out = await sup.start(req);
    if (out.kind !== "facts") throw new Error("start refused");
    // Wait for the FULL log (the CFG block closes the shim's write sequence,
    // so seeing `>>` means ARGS/ENV/ENVKEYS/CFG all landed):
    await waitFor(() => shimLog(shim.log).includes("CFG:<<") && shimLog(shim.log).includes("\n>>"));
    const argvLine = shimArgs(shim.log)[0]!;
    expect(argvLine).toContain("-F");
    expect(argvLine).toContain(join(dataDir, "ssh", "runs", req.runId, "config"));
    expect(argvLine).toContain("-- target.example");
    expect(argvLine).toContain("cd '/srv/app' && echo hi");
    expect(argvLine).toContain("-p 2202");
    expect(argvLine).toContain("-l ops");
    // policy flags live in the CONFIG (every hop reads it), asserted from the
    // file the shim recorded when it was invoked with -F:
    const cfg = shimLog(shim.log).match(/CFG:<<\n([\s\S]*?)\n>>/) ?? [];
    expect(String(cfg[1])).toContain("BatchMode yes");
    expect(String(cfg[1])).toContain("StrictHostKeyChecking yes");
    expect(String(cfg[1])).toContain("EscapeChar none");
    expect(String(cfg[1])).toContain("ControlPath none");
    // the ENV the shim saw: no askpass hook, no inherited Subshell secret
    const envLine =
      shimLog(shim.log)
        .split("\n")
        .find((l) => l.startsWith("ENV:")) ?? "";
    expect(envLine).toContain("ask=");
    expect(envLine).toContain("auth=");
    expect(envLine).not.toContain("ask=/");
    expect(shimLog(shim.log)).not.toContain("SUBSHELL_API_KEY");
    expect(shimLog(shim.log)).not.toContain("BETTER_AUTH_SECRET");
    expect(shimLog(shim.log)).not.toContain("SSH_ASKPASS=");
    expect(shimLog(shim.log)).not.toContain("SSH_ASKPASS_REQUIRE");
  });

  it("names the auth agent ONLY when the snapshot does", async () => {
    const { sup, shim } = fixture("agent", {});
    const req = { ...baseReq(2), snapshot: { ...baseReq(2).snapshot, authAgentSocket: "/tmp/agent.sock" } };
    await sup.start(req);
    await waitFor(() => shimLog(shim.log).includes("\nENV:"));
    const envLine =
      shimLog(shim.log)
        .split("\n")
        .find((l) => l.startsWith("ENV:")) ?? "";
    expect(envLine).toContain("auth=/tmp/agent.sock");
  });
});

describe("lifecycle facts", () => {
  it("a clean exit 0 is a confirmed remote status; stdout and stderr stay separate", async () => {
    const { sup } = fixture("clean", { stdout: "out-1\n", stderr: "err-1\n", exitCode: 0 });
    const req = baseReq(3);
    const out = await sup.start(req);
    expect(out.kind).toBe("facts");
    await waitFor(() => sup.status(req.runId)?.lifecycle === "completed");
    const facts = sup.status(req.runId);
    expect(facts).not.toBeNull();
    expect(parseNodeSshRunFacts(facts)).not.toBeNull();
    expect(facts?.remoteStatus).toBe(0);
    expect(facts?.remoteStatusConfirmed).toBe(true);
    const read = await sup.read(req.runId, 0, 0, 256 * 1024, 0);
    expect(read).not.toBeNull();
    expect(parseNodeSshRunReadResult(read)).not.toBeNull();
    expect(Buffer.from(read!.stdoutB64, "base64").toString()).toBe("out-1\n");
    expect(Buffer.from(read!.stderrB64, "base64").toString()).toBe("err-1\n");
    expect(read!.stdoutNext).toBe(6);
    expect(read!.stderrNext).toBe(6);
    expect(read!.truncated).toBe(false);
  });

  it("exit 7 is the remote status 7, confirmed", async () => {
    const { sup } = fixture("exit7", { exitCode: 7 });
    const req = baseReq(4);
    await sup.start(req);
    await waitFor(() => sup.status(req.runId)?.lifecycle === "completed");
    expect(sup.status(req.runId)?.remoteStatus).toBe(7);
    expect(sup.status(req.runId)?.remoteStatusConfirmed).toBe(true);
  });

  it("an uncorroborated 255 is the ambiguity itself: unknown carrying 255, never confirmed", async () => {
    const { sup } = fixture("255-bare", { exitCode: 255 });
    const req = baseReq(5);
    await sup.start(req);
    await waitFor(() => sup.status(req.runId) !== null && sup.status(req.runId)?.lifecycle !== "running");
    const facts = sup.status(req.runId);
    expect(facts?.lifecycle).toBe("unknown");
    expect(facts?.remoteStatus).toBe(255);
    expect(facts?.remoteStatusConfirmed).toBe(false);
    // the facts grammar itself accepts exactly this combination
    expect(parseNodeSshRunFacts(facts)).not.toBeNull();
  });

  it("a 255 corroborated by transport facts is ssh's failure: no remote status, no remote claim", async () => {
    const { sup } = fixture("255-transport", {
      exitCode: 255,
      stderr: "ssh: connect to host target port 2202: Connection refused\r\n",
    });
    const req = baseReq(6);
    await sup.start(req);
    await waitFor(() => {
      const s = sup.status(req.runId);
      return s !== null && s.lifecycle !== "running" && s.lifecycle !== "accepted";
    });
    const facts = sup.status(req.runId);
    expect(facts?.lifecycle).toBe("completed");
    expect(facts?.remoteStatus).toBeNull();
    expect(facts?.remoteStatusConfirmed).toBe(false);
    expect(facts?.localExitCode).toBe(255);
  });

  it("a child that cannot spawn at all reads back unknown, never retried", async () => {
    const dir = join(root, "no-spawn");
    mkdirSync(join(dir, "data"), { recursive: true });
    const sup = new SshRunSupervisor({
      dataDir: join(dir, "data"),
      homeDir: dir,
      sshBin: "/nonexistent/definitely-not-ssh",
    });
    const req = baseReq(7);
    const out = await sup.start(req);
    expect(out.kind).toBe("facts");
    expect(out.kind === "facts" && out.facts.lifecycle).toBe("unknown");
    // exactly ONE record exists; the state is terminal (no second attempt was made, none will be)
    expect(listRunIds(join(dir, "data"))).toEqual([req.runId]);
    expect(sup.status(req.runId)?.lifecycle).toBe("unknown");
  });
});

describe("dedup and replay", () => {
  it("duplicate delivery returns existing state and spawns NOTHING twice", async () => {
    const { sup, shim } = fixture("dedup", { exitCode: 0 });
    const req = baseReq(8);
    const first = await sup.start(req);
    await waitFor(() => shimArgs(shim.log).length >= 1);
    const second = await sup.start(req);
    expect(first.kind === "facts" && second.kind === "facts").toBe(true);
    await Bun.sleep(50);
    expect(shimArgs(shim.log).length).toBe(1); // ONE spawn for two deliveries
  });

  it("a different payload under the same id answers the conflict, and nothing new spawns", async () => {
    const { sup, shim } = fixture("conflict", { exitCode: 0 });
    const req = baseReq(9);
    await sup.start(req);
    await waitFor(() => shimArgs(shim.log).length >= 1);
    const out = await sup.start({ ...req, requestDigest: makeDigest("a-different-request"), command: "rm -rf /" });
    expect(out).toEqual({ kind: "refused", code: "run_conflict" });
    expect(shimArgs(shim.log).length).toBe(1);
  });
});

describe("output bounds: cap, drain, truncation", () => {
  it("past the combined retention the drain keeps draining, the store holds exactly the cap, and reads report truncated", async () => {
    const dir = join(root, "cap");
    mkdirSync(dir, { recursive: true });
    const big = join(dir, "11m.bin");
    writeFileSync(big, Buffer.alloc(0));
    truncateSync(big, SSH_RUN_OUTPUT_RETENTION_BYTES + 1024 * 1024);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    const shim = writeSshShim(join(dir, "bin"), { stdoutFile: big, exitCode: 0 });
    const sup = new SshRunSupervisor({ dataDir, homeDir: dir, sshBin: shim.bin });
    const req = baseReq(10);
    await sup.start(req);
    await waitFor(() => {
      const s = sup.status(req.runId);
      return s !== null && (s.lifecycle === "completed" || s.lifecycle === "unknown");
    }, 10_000);
    const read = await sup.read(req.runId, 0, 0, 1024, 0);
    expect(read!.stdoutTotal).toBe(SSH_RUN_OUTPUT_RETENTION_BYTES);
    expect(read!.truncated).toBe(true);
    expect(read!.stdoutB64.length).toBeGreaterThan(0);
  });
});

describe("cancellation and deadline", () => {
  it("cancel stops the local group within the grace and says so honestly", async () => {
    const { sup } = fixture("cancel", { sleep: 30 });
    const req = baseReq(11);
    await sup.start(req);
    await waitFor(() => sup.liveRunIds().includes(req.runId));
    const facts = await sup.cancel(req.runId);
    expect(facts?.cancelRequested).toBe(true);
    expect(facts?.cancelLocalConfirmed).toBe(true); // `exec sleep` dies on the group TERM
    await waitFor(() => sup.liveRunIds().length === 0);
    const final = sup.status(req.runId);
    expect(final?.lifecycle).toBe("completed"); // stopped by us; remote outcome: none claimed
    expect(final?.remoteStatus).toBeNull();
    expect(final?.remoteStatusConfirmed).toBe(false);
  });

  it("cancel of an unknown id answers the store's null (the run_unknown branch)", async () => {
    const { sup } = fixture("cancel-unknown", {});
    expect(await sup.cancel(makeRunId(999))).toBeNull();
    expect(sup.status(makeRunId(999))).toBeNull();
  });

  it("the deadline hits as a supervision fact and stops the child; nothing about the remote is claimed", async () => {
    const { sup } = fixture("deadline", { sleep: 60 });
    const req = { ...baseReq(12), deadlineMs: 300 };
    await sup.start(req);
    await waitFor(() => {
      const s = sup.status(req.runId);
      return s?.deadlineHit && s.lifecycle === "completed";
    }, 5_000);
    const facts = sup.status(req.runId);
    expect(facts?.deadlineHit).toBe(true);
    expect(facts?.remoteStatus).toBeNull();
    expect(sup.liveRunIds()).not.toInclude(req.runId);
  });
});

describe("long-poll read", () => {
  it("a timed-out wait answers an empty window with current facts: nothing yet, not an error", async () => {
    const { sup } = fixture("poll-timeout", { sleep: 10 }); // emits nothing
    const req = baseReq(13);
    await sup.start(req);
    const started = Date.now();
    const read = await sup.read(req.runId, 0, 0, 1024, 400);
    const elapsed = Date.now() - started;
    expect(read).not.toBeNull();
    expect(read!.lifecycle).toBe("running");
    expect(read!.stdoutB64).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
    await sup.cancel(req.runId);
  });

  it("output that lands during the wait releases the poll early", async () => {
    const dir = join(root, "poll-grow");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const shim = writeSshShim(join(dir, "bin"), { stdout: "late-bytes\n", sleep: 10 });
    const sup = new SshRunSupervisor({ dataDir, homeDir: dir, sshBin: shim.bin });
    const req = baseReq(14);
    await sup.start(req);
    const started = Date.now();
    const read = await sup.read(req.runId, 0, 0, 1024, 5_000);
    expect(Buffer.from(read!.stdoutB64, "base64").toString()).toBe("late-bytes\n");
    expect(Date.now() - started).toBeLessThan(4_500);
    await sup.cancel(req.runId);
  });
});

describe("quotas and storage pressure", () => {
  it("the 16-active-per-node cap refuses the 17th start", async () => {
    const dir = join(root, "quota");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const sup = new SshRunSupervisor({ dataDir, homeDir: dir, sshBin: "/bin/true" });
    for (let i = 0; i < SSH_ACTIVE_RUNS_PER_NODE; i++) {
      acceptRun(
        dataDir,
        {
          runId: makeRunId(200 + i),
          requestDigest: makeDigest(`q${i}`),
          command: "c",
          remoteDir: null,
          deadlineMs: 60_000,
          snapshotConfigText: "Host *",
        },
        Date.now(),
      );
    }
    const out = await sup.start(baseReq(15));
    expect(out).toEqual({ kind: "refused", code: "quota_runs" });
  });

  it("aggregate pressure evicts completed output first; a still-full store refuses new work with storage_full", async () => {
    const GiB = 1024 * 1024 * 1024;
    // Phase 1: a COMPLETED run holding 1 GiB + 1 byte — the next start evicts
    // its output and accepts the work (SSH-SUPPORT.md §3's pressure rule).
    const a = fixture("pressure-done", { exitCode: 0 });
    const done = makeRunId(300);
    acceptRun(
      a.dataDir,
      {
        runId: done,
        requestDigest: makeDigest("s1"),
        command: "c",
        remoteDir: null,
        deadlineMs: 60_000,
        snapshotConfigText: "Host *",
      },
      1,
    );
    closeSync(openRunStreamAppend(a.dataDir, done, "stdout"));
    truncateSync(join(a.dataDir, "ssh", "runs", done, "stdout.log"), GiB + 1);
    writeRunState(a.dataDir, {
      runId: done,
      lifecycle: "completed",
      cancelRequested: false,
      cancelLocalConfirmed: false,
      deadlineHit: false,
      remoteStatus: 0,
      remoteStatusConfirmed: true,
      localExitCode: 0,
      localExitSignal: null,
      startedAtMs: 1,
      finishedAtMs: 1,
      outputEvicted: false,
      spawned: true,
    });
    const first = await a.sup.start(baseReq(16));
    expect(first.kind).toBe("facts"); // evicted the completed output, accepted the work

    // Phase 2: the pressure holder is RUNNING — unevictable — so the refusal
    // is the honest "still full" answer, and it happens BEFORE any spawn.
    const b = fixture("pressure-live", { sleep: 30 });
    const live = baseReq(17);
    await b.sup.start(live);
    await waitFor(() => b.sup.liveRunIds().includes(live.runId));
    closeSync(openRunStreamAppend(b.dataDir, live.runId, "stdout"));
    truncateSync(join(b.dataDir, "ssh", "runs", live.runId, "stdout.log"), GiB + 1);
    const second = await b.sup.start(baseReq(18));
    expect(second).toEqual({ kind: "refused", code: "storage_full" });
    await b.sup.cancel(live.runId);
  });
});

describe("boot reconciliation and the registry", () => {
  it("reconcile flips unsupervised accepted/running records to unknown", async () => {
    const dir = join(root, "recon");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const sup = new SshRunSupervisor({ dataDir, homeDir: dir, sshBin: "/bin/true" });
    const r = baseReq(19);
    acceptRun(dataDir, { ...r, snapshotConfigText: "Host *" }, 1);
    const changed = sup.reconcileAtBoot();
    expect(changed.map((f) => f.runId)).toEqual([r.runId]);
    expect(readRun(dataDir, r.runId)?.state.lifecycle).toBe("unknown");
  });

  it("the registry hands one supervisor per data dir and peek never builds one", () => {
    resetSshSupervisorsForTests();
    const dir = join(root, "registry");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    expect(peekSshRunSupervisor(dataDir)).toBeUndefined();
    const a = getSshRunSupervisor({ dataDir, homeDir: dir, sshBin: "/bin/true" });
    expect(getSshRunSupervisor({ dataDir, homeDir: dir, sshBin: "/bin/true" })).toBe(a);
    expect(peekSshRunSupervisor(dataDir)).toBe(a);
    resetSshSupervisorsForTests();
  });
});
