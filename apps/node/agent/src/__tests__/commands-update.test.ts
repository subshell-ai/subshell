import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostReleaseTarget,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_MANIFEST_UNVERIFIED,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  type NodeRuntimeReport,
  parseReleaseManifest,
  releaseAssetNames,
} from "@internal/subshell-protocol";
import type { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execUpdate } from "../commands/update.js";

/**
 * A machine with NO service definition, whatever the host has.
 *
 * `update` resolves the binary it replaces by asking the service definition
 * first, and that read reaches the real launchd/systemd user domain —
 * `homedir()` answers from the password database, not `$HOME`, so no temp
 * directory hides it. Without this the tests below resolved the DEVELOPER's
 * own installed agent, and this file passed only on machines that do not run
 * Subshell (measured 2026-09-18). All three stubs are needed: the darwin
 * branch also shells out to `plutil`.
 */
const NO_SERVICE_DEFINITION = {
  fileExists: async () => false,
  readFile: async () => null,
  runCmd: async () => ({ code: 1, out: "", err: "" }),
} as const;

import { updateSeams } from "../update.js";
import { NODE_VERSION } from "../version.js";

/** The same fake verifier `update.test.ts` uses: accepts the TEST-ARMOR pair only. */
const acceptSigned: typeof verifyReleaseManifest = async (bytes, sig, _pub, expected) => {
  const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
  if (parsed === null || sig !== "TEST-ARMOR") return { ok: false, reason: "test: the fixture signature was refused" };
  if (parsed.component !== expected.component || parsed.version !== expected.version) {
    return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
  }
  return { ok: true, manifest: parsed };
};
const realUpdateSeams = { ...updateSeams };

/**
 * The `update` executor: its refusals, and the ordering of its success.
 *
 * The refusal cases end before the network, deliberately. An update is a
 * restart with a file swap in front of it, so both of `service restart`'s
 * refusals apply and they apply FIRST — a refusal that arrives after 70 MB has
 * crossed the wire is a worse refusal for having been late. Their URLs point
 * at nothing, so a case that ever reached the download would fail loudly
 * rather than pass by accident.
 *
 * The success case runs the whole thing for real against a `Bun.serve`, with
 * nothing stubbed but `process.execPath`. What it is there to pin is the
 * ORDER: `{ ok: true }` is the answer and `requestRestart` follows it, because
 * the daemon is the only sender of `result` and an executor that exited itself
 * would reach the plane as a timeout for an update that worked.
 */

function runtimeReport(over: Partial<NodeRuntimeReport> = {}): NodeRuntimeReport {
  return {
    startedAt: "2026-09-15T00:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/home/t/.config/systemd/user/subshell.service",
      state: "running",
      pid: 42,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/home/t/.config/subshell/config.json",
    agentLogPath: "/home/t/.config/subshell/logs/agent.log",
    logPath: null,
    logHint: null,
    logging: { debug: false, source: "default" },
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/home/t/.local/bin/subshell",
    ...over,
  };
}

async function ctxWith(runtime: NodeRuntimeReport | null, onRestart: () => void): Promise<CommandContext> {
  const dataDir = await mkdtemp(join(tmpdir(), "subshell-cmd-update-"));
  return {
    config: {
      serverUrl: "http://localhost:1",
      nodeId: "n",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "t",
    },
    tmux: {} as CommandContext["tmux"],
    meta: {} as CommandContext["meta"],
    nowMs: () => 0,
    binaryDeps: NO_SERVICE_DEFINITION,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime,
    requestRestart: onRestart,
  };
}

/**
 * A URL nothing serves — reaching it is the failure these cases are guarding.
 * The version is NEWER than this runner's `NODE_VERSION` on purpose: the
 * executor's version floor (C13) refuses non-newer offers before anything
 * else, and these cases are about the gates behind it.
 */
const unreachable = {
  type: "update" as const,
  version: "99.9.9",
  url: "http://127.0.0.1:1/never",
  sha256: "0".repeat(64),
};

describe("execUpdate refusals", () => {
  it("refuses an unsupervised agent, because exiting would be a stop rather than a restart", async () => {
    let restarts = 0;
    const ctx = await ctxWith(runtimeReport({ supervised: false }), () => restarts++);
    expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(restarts).toBe(0);
  });

  it("refuses with NO runtime report at all — a missing report is less evidence, not more", async () => {
    // The correction `execService` carries: `runtime &&` used to skip the
    // whole check on exactly the machine that could say least about itself.
    let restarts = 0;
    const ctx = await ctxWith(null, () => restarts++);
    expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(restarts).toBe(0);
  });

  it("refuses a definition that would kill live panes, and fails CLOSED on `unknown`", async () => {
    for (const paneSafety of ["kills", "unknown"] as const) {
      const ctx = await ctxWith(
        runtimeReport({ service: { ...runtimeReport().service, paneSafety } }),
        () => undefined,
      );
      expect(await dispatchCommand(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_KILLS_PANES });
    }
  });

  it("maps an applyUpdate refusal onto the WIRE CONSTANT, never a sentence", async () => {
    // The plane matches `NodeRpcError.detail` by equality, so an executor that
    // answered `applyUpdate`'s human message ("this agent is running from a
    // source checkout…") would produce a 500 naming nothing an operator can
    // act on. The refusal this suite gets is NOT_COMPILED because the test
    // runner IS an interpreter running a script — which is the same thing a
    // dev agent under `bun run` reports, and exactly the right answer there.
    const ctx = await ctxWith(runtimeReport(), () => undefined);
    const result = await dispatchCommand(ctx, unreachable);
    expect(result).toEqual({ ok: false, error: NODE_RESULT_NOT_COMPILED });
  });

  it("lets force past the pane refusal but never past the supervision one", async () => {
    // `force` means "act although panes will die". It cannot mean "exit a
    // process nothing will respawn" — that is not a restart at any setting.
    const unsupervised = await ctxWith(runtimeReport({ supervised: false }), () => undefined);
    expect(await dispatchCommand(unsupervised, { ...unreachable, force: true })).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_SUPERVISED,
    });
    const killsPanes = await ctxWith(
      runtimeReport({ service: { ...runtimeReport().service, paneSafety: "kills" } }),
      () => undefined,
    );
    // Past the pane gate, so it reaches `applyUpdate` and fails THERE (this
    // runner is an interpreter, so NOT_COMPILED) rather than at the gate.
    expect(await dispatchCommand(killsPanes, { ...unreachable, force: true })).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_COMPILED,
    });
  });

  it("refuses a downgrade order before anything is downloaded — the node's own floor", async () => {
    // C13. The plane gates downgrades and up-to-date offers
    // (`update-node.route.ts`) before it signs anything; this is the second
    // gate, for a control plane that is confused or compromised. The sentence
    // mirrors the CLI's, and reaching the unreachable URL would prove the
    // guard came too late.
    let restarts = 0;
    const ctx = await ctxWith(runtimeReport(), () => restarts++);
    expect(await dispatchCommand(ctx, { ...unreachable, version: "0.0.1" })).toEqual({
      ok: false,
      error: `0.0.1 is older than the running ${NODE_VERSION}`,
    });
    expect(restarts).toBe(0);
  });

  it("refuses an equal version even under force — nothing to install is nothing to install", async () => {
    // `force` answers the pane-safety refusal and the downgrade; re-swapping
    // ~70 MB for a byte-identical binary is not what it has ever meant.
    const ctx = await ctxWith(runtimeReport(), () => undefined);
    expect(await dispatchCommand(ctx, { ...unreachable, version: NODE_VERSION, force: true })).toEqual({
      ok: false,
      error: `already at subshell ${NODE_VERSION}`,
    });
  });

  it("lets force past the version floor, the way the loopback dashboard's downgrade offer needs", async () => {
    // The dashboard passes `force` for its explicit "allow a downgrade" — a
    // local keyboard act. The floor must not eat that offer: it proceeds to
    // `applyUpdate` and fails THERE on this runner (an interpreter), exactly
    // like the pane-force case above.
    const ctx = await ctxWith(runtimeReport(), () => undefined);
    expect(await dispatchCommand(ctx, { ...unreachable, version: "0.0.1", force: true })).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_COMPILED,
    });
  });

  it("does not ask the daemon to exit when the update did not happen", async () => {
    // The ordering that makes a plane-driven update legible: `requestRestart`
    // fires only after the swap, so a refused update leaves a live agent on
    // the socket that answered rather than a machine that bounced for nothing.
    let restarts = 0;
    const ctx = await ctxWith(runtimeReport(), () => restarts++);
    await dispatchCommand(ctx, unreachable);
    expect(restarts).toBe(0);
  });
});

/**
 * The boot-window seam (round-3 review, finding 5): the loopback dashboard
 * has no socket and no frozen report during boot (or after a failed boot-time
 * service read), and it answers supervision with one live manager query. That
 * proof must be the executor's answer — the null it just disproven must not
 * 409 the supervised node — while a caller WITHOUT a proof (the plane path)
 * keeps the old refusal verbatim. Every case here lands either at a wire
 * constant or at `applyUpdate`'s NOT_COMPILED on this runner (an interpreter),
 * exactly like the force cases above: "reached the installer" is what passing
 * both gates looks like without running it.
 */
describe("execUpdate supervision proof", () => {
  it("refuses on a null runtime with NO proof — the plane-commanded path is unchanged", async () => {
    const ctx = await ctxWith(null, () => undefined);
    expect(await execUpdate(ctx, unreachable)).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
  });

  it("a proof of supervision answers the null and reaches the installer", async () => {
    const ctx = await ctxWith(null, () => undefined);
    expect(
      await execUpdate({ ...ctx, supervisedProof: { supervised: true, paneSafety: "keeps" } }, unreachable),
    ).toEqual({ ok: false, error: NODE_RESULT_NOT_COMPILED });
  });

  it("the same query's `kills` still refuses, and force past it proceeds like any kills refusal", async () => {
    const ctx = await ctxWith(null, () => undefined);
    expect(
      await execUpdate({ ...ctx, supervisedProof: { supervised: true, paneSafety: "kills" } }, unreachable),
    ).toEqual({ ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(
      await execUpdate(
        { ...ctx, supervisedProof: { supervised: true, paneSafety: "kills" } },
        {
          ...unreachable,
          force: true,
        },
      ),
    ).toEqual({ ok: false, error: NODE_RESULT_NOT_COMPILED });
  });

  it("a proof of supervision ALONE fails closed on pane safety — no answer is still no evidence", async () => {
    const ctx = await ctxWith(null, () => undefined);
    expect(await execUpdate({ ...ctx, supervisedProof: { supervised: true } }, unreachable)).toEqual({
      ok: false,
      error: NODE_RESULT_KILLS_PANES,
    });
  });

  it("a proof that did NOT confirm supervision is the plain refusal", async () => {
    const ctx = await ctxWith(null, () => undefined);
    expect(
      await execUpdate({ ...ctx, supervisedProof: { supervised: false, paneSafety: "keeps" } }, unreachable),
    ).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
  });

  it("the frozen report OUTRANKS a proof, in both directions", async () => {
    // Supervision cannot change while the pid does not, so a caller's fresher-
    // looking query cannot un-say the boot's own answer — and a report that
    // DOES exist needs no proof beside it.
    const unsupervised = await ctxWith(runtimeReport({ supervised: false }), () => undefined);
    expect(
      await execUpdate({ ...unsupervised, supervisedProof: { supervised: true, paneSafety: "keeps" } }, unreachable),
    ).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    const supervised = await ctxWith(runtimeReport(), () => undefined);
    expect(await execUpdate({ ...supervised, supervisedProof: { supervised: false } }, unreachable)).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_COMPILED,
    });
  });
});

describe("execUpdate success", () => {
  it("swaps the binary, answers ok, and ONLY THEN asks the daemon to exit", async () => {
    // The whole plane-driven path, with nothing stubbed but `process.execPath`
    // and the publisher seam: a real HTTP server serves the artifact, the
    // digest is real, the manifest+signature ride with the command exactly as
    // protocol 12 sends them (spec 2026-09-17 §6), and the "binary" is a shell
    // script that answers `subshell 0.9.9` — which is what lets the
    // executor's own version probe run for real rather than through a seam
    // this command has no way to inject.
    const root = await mkdtemp(join(tmpdir(), "subshell-cmd-update-ok-"));
    const binary = join(root, "subshell");
    await writeFile(binary, "#!/bin/sh\necho 'subshell 0.8.0 (node protocol v9)'\n");
    await chmod(binary, 0o755);
    const next = "#!/bin/sh\necho 'subshell 99.9.9 (node protocol v12)'\n";
    const server = Bun.serve({ port: 0, fetch: () => new Response(next) });
    const digest = new Bun.CryptoHasher("sha256").update(next).digest("hex");
    const host = hostReleaseTarget(process.platform, process.arch);
    if (host === null) throw new Error("test host has no published node target");
    const hostAsset = releaseAssetNames("cli-node", host).binary;
    const manifestBytes = JSON.stringify({
      component: "cli-node",
      version: "99.9.9",
      nodeProtocol: 12,
      minNodeVersion: "0.11.0",
      commit: "0".repeat(40),
      assets: { [hostAsset]: digest },
    });
    const execPathBefore = process.execPath;
    Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
    updateSeams.verifyManifest = acceptSigned;

    let restarts = 0;
    try {
      const ctx = await ctxWith(runtimeReport(), () => restarts++);
      const result = await dispatchCommand(ctx, {
        type: "update",
        version: "99.9.9",
        url: `http://127.0.0.1:${server.port}/agent`,
        sha256: digest,
        manifest: Buffer.from(manifestBytes, "utf8").toString("base64"),
        manifestSig: "TEST-ARMOR",
      });
      expect(result).toEqual({ ok: true });
      // The daemon is the only sender of `result`, so the executor asks for
      // the exit and the daemon defers it — a restart the plane read as a
      // timeout would be a success reported as a failure.
      expect(restarts).toBe(1);
    } finally {
      Object.defineProperty(process, "execPath", { value: execPathBefore, configurable: true, writable: true });
      Object.assign(updateSeams, realUpdateSeams);
      server.stop(true);
    }
    expect(await readFile(binary, "utf8")).toBe(next);
    expect(await readFile(`${binary}.previous`, "utf8")).toContain("0.8.0");
  });

  it("refuses a command that carried no signed manifest, after every other gate passes", async () => {
    // The gate-first tests never reach `applyUpdate`; this one does — supervised,
    // keeps-panes, a REAL artifact whose digest matches — and the refusal is
    // the MANIFEST constant, because a new agent that accepted an unsigned
    // command would silently reopen the hole the protocol bump closed.
    const root = await mkdtemp(join(tmpdir(), "subshell-cmd-update-nosig-"));
    const binary = join(root, "subshell");
    await writeFile(binary, "#!/bin/sh\necho 'subshell 0.8.0 (node protocol v11)'\n");
    await chmod(binary, 0o755);
    const next = "#!/bin/sh\necho 'subshell 99.9.9 (node protocol v12)'\n";
    const server = Bun.serve({ port: 0, fetch: () => new Response(next) });
    const digest = new Bun.CryptoHasher("sha256").update(next).digest("hex");
    const execPathBefore = process.execPath;
    Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
    try {
      const ctx = await ctxWith(runtimeReport(), () => undefined);
      const result = await dispatchCommand(ctx, {
        type: "update",
        version: "99.9.9",
        url: `http://127.0.0.1:${server.port}/agent`,
        sha256: digest,
      });
      expect(result).toEqual({ ok: false, error: NODE_RESULT_MANIFEST_UNVERIFIED });
    } finally {
      Object.defineProperty(process, "execPath", { value: execPathBefore, configurable: true, writable: true });
      server.stop(true);
    }
    expect(await readFile(binary, "utf8")).toContain("0.8.0");
  });
});
