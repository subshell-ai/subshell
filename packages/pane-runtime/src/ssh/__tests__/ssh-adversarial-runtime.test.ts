import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SSH_RUN_OUTPUT_RETENTION_BYTES } from "@internal/subshell-protocol";
import { SshRunSupervisor } from "../ssh-run-supervisor.js";
import { cleanup, makeDigest, makeRunId, tempRoot, writeSshShim } from "./helpers.js";

/**
 * WORKSTREAM G (Wave 2) - the §6 matrix rows "Resource limits" (infinite
 * output / OVERSIZED PARTIAL LINE / stalled client) and "Execution" viewed at
 * the runtime's storage floor: what a reader sees when a destination prints
 * ONE line larger than the retention cap, with no newline anywhere.
 *
 * The existing suites bound the two halves separately: the store test proves
 * offset/cap honesty over small liney data, and the supervisor test proves the
 * cap + `truncated` flag. What neither drives is the CURSOR story across a
 * single over-cap line: a reader mid-gigabyte-of-no-newline must be able to
 * continue exactly (no lost bytes, no repeats), must get at most the requested
 * window, and must see the truncation reported rather than a total that quietly
 * stops where the cap does. A line that never ends is the realistic shape of a
 * runaway progress bar, and it is the case a line-oriented reader gets wrong.
 *
 * Runs on the scripted ssh shim everywhere (no sshd needed): the shim cats a
 * pre-seeded file, so the bytes reaching the supervisor are a real child's
 * stdout arriving in chunks the same way a terminal would stream them.
 */

let root: string;
let dataDir: string;
let homeDir: string;

beforeAll(() => {
  root = tempRoot("subshell-ssh-adversarial-");
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  homeDir = join(root, "home");
  mkdirSync(homeDir);
});

afterAll(() => cleanup(root));

/** Run `command` through a fresh supervisor + shim and wait for it to settle. */
async function runWith(stdoutFile: string, runId: string): Promise<SshRunSupervisor> {
  const shim = writeSshShim(join(root, `shim-${runId}`), { stdoutFile });
  const sup = new SshRunSupervisor({ dataDir, homeDir, sshBin: shim.bin });
  const started = await sup.start({
    runId,
    requestDigest: makeDigest(runId),
    // A grammar-valid snapshot; the shim never connects, the contract under
    // test is the local capture path.
    snapshot: {
      alias: "adversarial",
      host: "adversarial.invalid",
      user: "deploy",
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      authAgentSocket: null,
      knownHostsFiles: ["/nonexistent/known_hosts"],
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
    remoteDir: null,
    command: "emit",
    deadlineMs: 20_000,
  });
  expect(started.kind).toBe("facts");
  return sup;
}

async function settled(sup: SshRunSupervisor, runId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const s = sup.status(runId);
    if (s && (s.lifecycle === "completed" || s.lifecycle === "unknown")) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} never settled`);
}

describe("oversized partial lines: exact cursor continuation, honest truncation (spec §6 Resource limits)", () => {
  it("a single line WITHIN the cap: reads cut mid-line at the exact requested byte and continue gap-free", async () => {
    const line = Buffer.alloc(300 * 1024, 0x78); // 300 KiB of 'x', NO newline
    const file = join(root, "partial-line.bin");
    writeFileSync(file, line);
    const runId = makeRunId(4001);
    const sup = await runWith(file, runId);
    await settled(sup, runId);

    const first = await sup.read(runId, 0, 0, 1024, 0);
    expect(first).not.toBeNull();
    const firstBytes = Buffer.from(first!.stdoutB64, "base64");
    expect(firstBytes.length).toBe(1024); // exactly the window, cut mid-line
    expect(first!.truncated).toBe(false); // under the retention cap: no discard
    expect(first!.stdoutNext).toBe(1024);

    // Continue where it stopped: byte 1024 onward is the SAME line, and the
    // concatenation is byte-identical to the source (no gap, no repeat).
    const second = await sup.read(runId, first!.stdoutNext, 0, 1024, 0);
    const secondBytes = Buffer.from(second!.stdoutB64, "base64");
    expect(Buffer.concat([firstBytes, secondBytes])).toEqual(line.subarray(0, 2048));

    // A stalled reader then jumps deep into the line: exact offsets, honest
    // total, and EOF answers zero bytes with the same total (never a guess).
    const deep = await sup.read(runId, 150 * 1024, 0, 4096, 0);
    expect(Buffer.from(deep!.stdoutB64, "base64")).toEqual(line.subarray(150 * 1024, 150 * 1024 + 4096));
    expect(deep!.stdoutTotal).toBe(line.length);
    const past = await sup.read(runId, line.length + 4096, 0, 1024, 0);
    expect(Buffer.from(past!.stdoutB64, "base64").length).toBe(0);
    expect(past!.stdoutTotal).toBe(line.length);
  }, 30_000);

  it("a single line PAST the cap: the child is still drained to its end, the store holds the cap, and reads report truncated with exact continuation", async () => {
    // One line, cap + 1 MiB, no newline: the drain must never stop reading
    // (a child blocked on an unread pipe never exits) and must never store
    // past the cap.
    const over = Buffer.alloc(SSH_RUN_OUTPUT_RETENTION_BYTES + 1024 * 1024, 0x79);
    const file = join(root, "over-cap-line.bin");
    writeFileSync(file, over);
    const runId = makeRunId(4002);
    const sup = await runWith(file, runId);
    await settled(sup, runId); // the child exits on its own: draining, not blocking

    const head = await sup.read(runId, 0, 0, 2048, 0);
    expect(head).not.toBeNull();
    expect(Buffer.from(head!.stdoutB64, "base64").length).toBe(2048);
    expect(head!.truncated).toBe(true); // the honest flag: this is NOT the whole transcript
    expect(head!.stdoutTotal).toBeLessThanOrEqual(SSH_RUN_OUTPUT_RETENTION_BYTES); // never a lie about size

    // Continuation still works mid-line against the retained prefix; the tail
    // the cap discarded cannot be resumed (the cursor reaches the retained EOF
    // with an honest total).
    const mid = await sup.read(runId, SSH_RUN_OUTPUT_RETENTION_BYTES - 1024, 0, 4096, 0);
    const midBytes = Buffer.from(mid!.stdoutB64, "base64");
    expect(midBytes.length).toBe(1024); // exactly the retained remainder
    expect(midBytes.equals(over.subarray(SSH_RUN_OUTPUT_RETENTION_BYTES - 1024, SSH_RUN_OUTPUT_RETENTION_BYTES))).toBe(
      true,
    );
  }, 120_000);

  it("a huge single line does not corrupt the FACTS of its run (completed, status confirmed)", async () => {
    const file = join(root, "facts-line.bin");
    writeFileSync(file, Buffer.alloc(512 * 1024, 0x7a)); // still no newline
    const shim = writeSshShim(join(root, "shim-facts"), { stdoutFile: file, exitCode: 7 });
    const sup = new SshRunSupervisor({ dataDir, homeDir, sshBin: shim.bin });
    const started = await sup.start({
      runId: makeRunId(4003),
      requestDigest: makeDigest("facts-line"),
      snapshot: {
        alias: "adversarial",
        host: "adversarial.invalid",
        user: "deploy",
        port: 22,
        identityFiles: [],
        certificateFiles: [],
        authAgentSocket: null,
        knownHostsFiles: ["/nonexistent/known_hosts"],
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
      remoteDir: null,
      command: "emit-and-fail",
      deadlineMs: 20_000,
    });
    expect(started.kind).toBe("facts");
    await settled(sup, "00000000-0000-4000-8000-000000004003");
    const facts = sup.status("00000000-0000-4000-8000-000000004003");
    expect(facts?.lifecycle).toBe("completed");
    expect(facts?.remoteStatus).toBe(7); // a status in [0,254] over an established transport
    expect(facts?.remoteStatusConfirmed).toBe(true); // output shape cannot dent exit honesty
  }, 30_000);
});
