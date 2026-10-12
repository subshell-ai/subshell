import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshProcessResult } from "@internal/pane-runtime";
import type { JsonValue, NodeCommandBody, SshHostKeyCommand } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execSshHostKey, type HostKeySeams, sshHostKeyCandidates } from "../commands/ssh-host-key.js";
import { writeSshEnabled } from "../ssh-enabled.js";

/**
 * The `ssh_host_key` capture arm (spec 2026-10-08 §9, Task 12): A answers the
 * `known_hosts` entries for one resolved destination so the plane can
 * capture the pin the relay-open carries to B. Posture copied from
 * commands-ssh.test.ts (real temp dirs, the gate mirror written by its own
 * writer, refusals by `ok:false` + message) with the ssh-keygen run replaced
 * by the executor's `runProcess` seam - the OPPOSITE of what runs against a
 * real agent is what the tests pin here: the candidate SPELLINGS, the
 * comment-header strip, the dedup, and the fail-closed error classes. The
 * real `ssh-keygen -F` behavior against a fixture file is the same tool's
 * behavior at the sshd suite's disposal; this file owns the arm's decisions.
 */

const STAMP = "2026-10-08T10:00:00.000Z";
const GATE_REFUSAL = "ssh disabled on this node";
const LINE_A = "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000";

let base: string;
let savedKeygen: string | undefined;
let savedKnownHosts: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-hostkey-")));
  savedKeygen = process.env.SUBSHELL_SSH_KEYGEN_PATH;
  savedKnownHosts = process.env.SUBSHELL_SSH_KNOWN_HOSTS;
});

afterAll(() => {
  if (savedKeygen === undefined) delete process.env.SUBSHELL_SSH_KEYGEN_PATH;
  else process.env.SUBSHELL_SSH_KEYGEN_PATH = savedKeygen;
  if (savedKnownHosts === undefined) delete process.env.SUBSHELL_SSH_KNOWN_HOSTS;
  else process.env.SUBSHELL_SSH_KNOWN_HOSTS = savedKnownHosts;
  rmSync(base, { recursive: true, force: true });
});

function dataDir(tag: string, gateOn: boolean): string {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  if (gateOn) writeSshEnabled(dir, { on: true, changedAt: STAMP });
  return dir;
}

function makeCtx(tag: string, gateOn = true): CommandContext {
  return { config: { dataDir: dataDir(tag, gateOn) } } as unknown as CommandContext;
}

function cmd(over: Partial<SshHostKeyCommand> = {}): SshHostKeyCommand {
  return { type: "ssh_host_key", host: "git.example.test", port: 22, user: null, ...over };
}

function trustFile(tag: string, content: string | null): string {
  const path = join(base, tag, "known_hosts");
  mkdirSync(join(base, tag), { recursive: true });
  if (content !== null) writeFileSync(path, content, { mode: 0o600 });
  return path;
}

interface KeygenCall {
  candidate: string;
  argv: readonly string[];
}

/** A fake ssh-keygen: canned stdout per candidate, with the call log. */
function fakeRun(byCandidate: Record<string, Partial<SshProcessResult>>): {
  run: NonNullable<HostKeySeams["runProcess"]>;
  calls: KeygenCall[];
} {
  const calls: KeygenCall[] = [];
  return {
    calls,
    run: async (argv): Promise<SshProcessResult> => {
      const candidate = argv[argv.length - 1];
      calls.push({ candidate, argv });
      const canned = byCandidate[candidate] ?? {};
      return {
        code: canned.code ?? 0,
        stdout: canned.stdout ?? "",
        stderr: canned.stderr ?? "",
        timedOut: canned.timedOut ?? false,
        spawnError: canned.spawnError ?? false,
      };
    },
  };
}

function seamsFor(trust: string, run: HostKeySeams["runProcess"]): HostKeySeams {
  return {
    resolveKeygenBin: async () => "/usr/bin/ssh-keygen",
    trustFile: () => trust,
    runProcess: run ?? (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, spawnError: false })),
  };
}

describe("ssh_host_key candidates (OpenSSH's lookup spellings)", () => {
  it("uses the destination port and excludes the login account", () => {
    expect(sshHostKeyCandidates(cmd())).toEqual(["git.example.test"]);
    expect(sshHostKeyCandidates(cmd({ port: 2222, user: "deploy" }))).toEqual(["[git.example.test]:2222"]);
    expect(sshHostKeyCandidates(cmd({ host: "[::1]", port: 2222 }))).toEqual(["[::1]:2222"]);
    expect(sshHostKeyCandidates(cmd({ host: "[::1]" }))).toEqual(["::1"]);
  });
});

describe("ssh_host_key arm (gate ON)", () => {
  it("the gate speaks before any lookup: no keygen resolution, no run", async () => {
    let resolved = false;
    const res = await execSshHostKey(makeCtx("gate", false), cmd(), {
      resolveKeygenBin: async () => {
        resolved = true;
        return "/usr/bin/ssh-keygen";
      },
    });
    expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
    expect(resolved).toBe(false);
  });

  it("an absent trust file is the honest EMPTY answer - the capture's fail-closed fact, not an error", async () => {
    const missing = join(base, "never-created", "known_hosts");
    const fake = fakeRun({});
    const res = await execSshHostKey(makeCtx("missing"), cmd(), seamsFor(missing, fake.run));
    expect(res).toEqual({ ok: true, data: { lines: [] } });
    // Nothing spawned: the file's ABSENCE is answered without OpenSSH.
    expect(fake.calls).toHaveLength(0);
  });

  it("a missing ssh-keygen refuses by name (the binary-ladder message class)", async () => {
    const trust = trustFile("nokeygen", `${LINE_A}\n`);
    const res = await execSshHostKey(makeCtx("nokeygen"), cmd(), {
      resolveKeygenBin: async () => null,
      trustFile: () => trust,
    });
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("binary missing");
  });

  it("answers the matching entry verbatim, headers and blanks stripped, argv spelled -f file -F candidate", async () => {
    const trust = trustFile("match", `${LINE_A}\n# a comment\nother.example ssh-rsa BBB\n`);
    const fake = fakeRun({
      "git.example.test": {
        stdout: `# Host git.example.test found: line 2\n${LINE_A}\n`,
      },
    });
    const res = await execSshHostKey(makeCtx("match"), cmd(), seamsFor(trust, fake.run));
    expect(res.ok).toBe(true);
    expect((res as { data: JsonValue }).data).toEqual({ lines: [LINE_A] });
    // The ask spells the file target with `-f` (never a HOME-relative read)
    // and each candidate as its own argv element - no shell string anywhere.
    expect(fake.calls.map((c) => c.candidate)).toEqual(["git.example.test"]);
    expect(fake.calls[0]?.argv.slice(0, 4)).toEqual(["/usr/bin/ssh-keygen", "-f", trust, "-F"]);
  });

  it("captures only the requested sshd when one host serves different keys on different ports", async () => {
    const alternate = LINE_A.replace("git.example.test", "[git.example.test]:2222").replace("AAAAI000", "AAAAI111");
    const trust = trustFile("separate-ports", `${LINE_A}\n${alternate}\n`);
    const fake = fakeRun({
      "git.example.test": { stdout: `${LINE_A}\n` },
      "[git.example.test]:2222": { stdout: `${alternate}\n` },
    });
    const res = await execSshHostKey(makeCtx("separate-ports"), cmd({ port: 2222 }), seamsFor(trust, fake.run));
    expect(res).toEqual({ ok: true, data: { lines: [alternate] } });
    expect(fake.calls.map((call) => call.candidate)).toEqual(["[git.example.test]:2222"]);
  });

  it("a silent non-zero run with stderr is the named unreadable-file refusal, never the empty fact", async () => {
    const trust = trustFile("unreadable", `${LINE_A}\n`);
    const fake = fakeRun({
      "[git.example.test]:22": { code: 1, stderr: "Load key ...: Permission denied" },
      "git.example.test": { code: 1, stderr: "Load key ...: Permission denied" },
    });
    const res = await execSshHostKey(makeCtx("unreadable"), cmd(), seamsFor(trust, fake.run));
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("could not be read");
  });

  it("a timeout and a spawn failure each refuse by name", async () => {
    const trust = trustFile("failures", `${LINE_A}\n`);
    const timeout = fakeRun({ "git.example.test": { timedOut: true } });
    const t = await execSshHostKey(makeCtx("failures"), cmd(), seamsFor(trust, timeout.run));
    expect(t.ok).toBe(false);
    expect(String((t as { error?: string }).error)).toInclude("deadline");
    const spawn = fakeRun({ "git.example.test": { spawnError: true } });
    const s = await execSshHostKey(makeCtx("failures"), cmd(), seamsFor(trust, spawn.run));
    expect(s.ok).toBe(false);
    expect(String((s as { error?: string }).error)).toInclude("could not be started");
  });

  it("an answer the frozen validator rejects (an over-cap line) is refused, not passed through", async () => {
    const trust = trustFile("malformed", "x\n");
    const huge = `host ssh-ed25519 ${"A".repeat(5000)}`;
    const fake = fakeRun({ "git.example.test": { stdout: `${huge}\n` }, "[git.example.test]:22": { code: 1 } });
    const res = await execSshHostKey(makeCtx("malformed"), cmd(), seamsFor(trust, fake.run));
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("malformed");
  });

  it("dispatch routes ssh_host_key to the HANDLER, not to unsupported (gate ON, no keygen, no trust file -> empty fact)", async () => {
    // Gate ON, a keygen that resolves, and an ABSENT trust file: only the
    // handler can produce the empty ok:true answer; `unsupported` here would
    // mean the dispatch arm is missing, the gate's words would mean it ran
    // before the lookup.
    process.env.SUBSHELL_SSH_KEYGEN_PATH = "/bin/sh";
    process.env.SUBSHELL_SSH_KNOWN_HOSTS = join(base, "dispatch-missing", "known_hosts");
    const res = await dispatchCommand(makeCtx("dispatch"), {
      type: "ssh_host_key",
      host: "git.example.test",
      port: 22,
      user: null,
    } satisfies NodeCommandBody);
    expect(res).toEqual({ ok: true, data: { lines: [] } });
  });

  it("dispatch routes to the HANDLER's binary-missing class when the file EXISTS (still not `unsupported`)", async () => {
    process.env.SUBSHELL_SSH_KEYGEN_PATH = "/nonexistent/ssh-keygen-binary";
    const trust = trustFile("dispatch-exists", `${LINE_A}\n`);
    process.env.SUBSHELL_SSH_KNOWN_HOSTS = trust;
    const res = await dispatchCommand(makeCtx("dispatch2"), {
      type: "ssh_host_key",
      host: "git.example.test",
      port: 22,
      user: null,
    } satisfies NodeCommandBody);
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("binary missing");
  });
});
