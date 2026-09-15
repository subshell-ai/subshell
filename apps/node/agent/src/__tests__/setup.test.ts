import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CliResult, parseArgs, run } from "../cli.js";
import { configPath, loadConfig } from "../config.js";
import { newHome } from "../test-preload.js";
import { serviceStub, UNIT } from "./helpers/service-stub.js";

/**
 * `subshell setup` — the whole enrollment in one verb (spec 2026-09-15 §4.5).
 * The defect it closes: `install.sh` ended at a foreground `subshell run`,
 * which dies with the SSH session, and nothing on the terminal path ever named
 * `service install`. So these tests care about the SEQUENCE (tmux → enroll →
 * service) and about who decides the service question, not about re-proving
 * enrollment, which `enroll.test.ts` owns.
 */

/** The canned 201 the real enroll route sends (spec 2026-08-31 §5.2). */
const CANNED = {
  nodeId: "node_setup_1",
  nodeKey: "subshell_key_never_printed",
  controlPublicKey: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
  wsUrl: "ws://localhost/ws/node",
};

let home: string;
let dataDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  home = newHome();
  dataDir = join(home, "data");
  server?.stop(true);
  server = undefined;
});

afterAll(() => server?.stop(true));

function fakeControlPlane(onRequest: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: onRequest });
  return `http://localhost:${server.port}`;
}

function plane(): string {
  return fakeControlPlane(() => Response.json(CANNED, { status: 201 }));
}

function setupArgv(serverUrl: string, ...extra: string[]): string[] {
  return ["setup", "--server", serverUrl, "--key", "nsk_test_0123456789", "--data-dir", dataDir, ...extra];
}

/**
 * Records every prompt asked, answering with a scripted reply.
 *
 * The seam answers in BOOLEANS — `null` is "nothing answered" (EOF, a closed
 * stdin, a cancel) and reads as a decline. It used to hand back "y"/"n" text
 * that `runSetup` re-parsed, which put the question's meaning in the caller
 * rather than in whatever rendered it; review (2026-09-15) matched it to the
 * server CLI's own boolean confirm.
 */
function recordingPrompt(answer: boolean | null) {
  const asked: Array<{ question: string; def: boolean }> = [];
  return {
    asked,
    prompt: (question: string, def: boolean) => {
      asked.push({ question, def });
      return answer;
    },
  };
}

// ── parsing ───────────────────────────────────────────────────────────────

test("setup takes enroll's flags plus --no-service/--yes, and refuses the others", () => {
  expect(parseArgs(["setup", "--server", "http://x:1", "--key", "k", "--no-service", "--yes", "--json"])).toEqual({
    command: "setup",
    flags: { server: "http://x:1", key: "k", noService: "1", yes: "1", json: "1" },
  });
  expect(() => parseArgs(["setup", "--probe"])).toThrow(/not valid for 'setup'/);
  expect(() => parseArgs(["setup", "--force"])).toThrow(/not valid for 'setup'/);
  // `--no-service` is setup's alone: enroll has no service step to opt out of.
  expect(() => parseArgs(["enroll", "--no-service"])).toThrow(/not valid for 'enroll'/);
});

test("setup without --server/--key is a usage error naming both", async () => {
  const res = await run(["setup"]);
  expect(res.code).toBe(2);
  expect(res.err).toInclude("--server <url>");
  expect(res.err).toInclude("--key <nsk_…>");
});

test("usage lists setup as the one-command path", async () => {
  const res = await run(["setup"]);
  expect(res.err).toInclude("subshell setup --server");
});

// ── the sequence ──────────────────────────────────────────────────────────

test("--yes enrolls, installs the service, and never asks", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(false);
  const res: CliResult = await run(setupArgv(url, "--yes"), { service: s.deps, prompt: p.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(p.asked).toEqual([]); // --yes is the answer; asking anyway would be theatre
  expect((await loadConfig()).nodeId).toBe(CANNED.nodeId);
  // installService's own output rides through verbatim — it carries the linger hint.
  expect(s.files.has(UNIT)).toBe(true);
  expect(res.out).toInclude(UNIT);
  expect(res.out).toInclude("This machine is a node.");
  expect(res.out).toInclude(`${url}/nodes`);
  // The node key has exactly one home, the 0600 config file.
  expect(`${res.out}${res.err}`).not.toInclude(CANNED.nodeKey);
});

test("a non-TTY without --yes takes the same default, silently", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(false);
  const res = await run(setupArgv(url), { service: s.deps, prompt: p.prompt, interactive: false });

  expect(res.code).toBe(0);
  expect(p.asked).toEqual([]); // nothing can answer, so nothing is printed
  expect(s.files.has(UNIT)).toBe(true);
});

test("--no-service enrolls and installs nothing, naming the command that would", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(true);
  const res = await run(setupArgv(url, "--no-service"), { service: s.deps, prompt: p.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(p.asked).toEqual([]); // the flag already answered
  expect(s.calls).toEqual([]); // no systemctl, no launchctl
  expect(s.files.size).toBe(0);
  expect(res.out).toInclude("subshell service install");
  expect(res.out).toInclude("This machine is a node.");
});

test("interactive: the question defaults to yes and its answer decides the install", async () => {
  const url = plane();
  const yes = serviceStub();
  const ask = recordingPrompt(true); // what pressing enter on a default-yes confirm yields
  const res = await run(setupArgv(url), { service: yes.deps, prompt: ask.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(ask.asked).toHaveLength(1);
  expect(ask.asked[0].question).toInclude("background");
  expect(ask.asked[0].def).toBe(true); // press-enter installs it
  expect(yes.files.has(UNIT)).toBe(true);
});

test("interactive: a plain no skips the install and says how to do it later", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(false);
  const res = await run(setupArgv(url), { service: s.deps, prompt: p.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(s.calls).toEqual([]);
  expect(res.out).toInclude("subshell service install");
});

test("interactive: a cancelled prompt declines rather than guessing yes", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(null); // EOF / Ctrl-C — clack's isCancel()
  const res = await run(setupArgv(url), { service: s.deps, prompt: p.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(s.calls).toEqual([]); // enrollment stands; the machine is untouched
  expect(res.out).toInclude("subshell service install");
});

// ── refusals and failures ─────────────────────────────────────────────────

test("tmux preflight refuses BEFORE the network, with enroll's own message", async () => {
  let hits = 0;
  const url = fakeControlPlane(() => {
    hits++;
    return Response.json(CANNED, { status: 201 });
  });
  const savedSkip = process.env.SUBSHELL_CLIENT_SKIP_TMUX_CHECK;
  delete process.env.SUBSHELL_CLIENT_SKIP_TMUX_CHECK;
  const realSpawnSync = Bun.spawnSync;
  const s = serviceStub();
  try {
    // Deterministic ENOENT whatever the host has installed (Bun falls back to a
    // default search path when PATH is empty, so the PATH trick lies).
    Bun.spawnSync = (() => ({
      exitCode: null,
      success: false,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    })) as unknown as typeof Bun.spawnSync;
    const res = await run(setupArgv(url, "--yes"), { service: s.deps });
    expect(res.code).toBe(1);
    expect(res.err).toInclude("tmux not found");
    expect(hits).toBe(0); // the setup key is not burned on an unenrollable box
    expect(existsSync(configPath())).toBe(false);
    expect(s.calls).toEqual([]);
  } finally {
    Bun.spawnSync = realSpawnSync;
    if (savedSkip !== undefined) process.env.SUBSHELL_CLIENT_SKIP_TMUX_CHECK = savedSkip;
  }
});

test("a failed service install is non-zero but says the enrollment survived", async () => {
  const url = plane();
  // daemon-reload fails — the classic "no systemd user session" container box.
  const s = serviceStub({
    respond: (cmd) =>
      cmd[2] === "daemon-reload"
        ? { code: 1, out: "", err: "Failed to connect to bus" }
        : { code: 0, out: "", err: "" },
  });
  const res = await run(setupArgv(url, "--yes"), { service: s.deps });

  expect(res.code).not.toBe(0);
  expect(res.err).toInclude("daemon-reload");
  // The half-done state is stated rather than left to be inferred from a
  // non-zero exit: the key IS spent and the config IS written.
  expect(res.out).toInclude(`Enrolled as ${CANNED.nodeId}`);
  expect(res.out).toInclude("subshell service install");
  expect((await loadConfig()).nodeId).toBe(CANNED.nodeId);
});

test("a rejected setup key fails with enroll's advice and installs nothing", async () => {
  const url = fakeControlPlane(() => Response.json({ code: "SETUP_KEY_CONSUMED", message: "spent" }, { status: 401 }));
  const s = serviceStub();
  const res = await run(setupArgv(url, "--yes"), { service: s.deps });

  expect(res.code).toBe(1);
  expect(res.err).toInclude("already been used");
  expect(s.calls).toEqual([]);
});

// ── --json ────────────────────────────────────────────────────────────────

test("--json emits the facts a script needs, asks nothing, and never the node key", async () => {
  const url = plane();
  const s = serviceStub();
  const p = recordingPrompt(false);
  const res = await run(setupArgv(url, "--json"), { service: s.deps, prompt: p.prompt, interactive: true });

  expect(res.code).toBe(0);
  expect(p.asked).toEqual([]); // a machine-readable run never prints a prompt
  const body = JSON.parse(res.out) as {
    nodeId: string;
    serverUrl: string;
    name: string;
    dataDir: string;
    configPath: string;
    service: { installed: boolean; reason?: string };
  };
  expect(body.nodeId).toBe(CANNED.nodeId);
  expect(body.serverUrl).toBe(url);
  expect(body.dataDir).toBe(dataDir);
  expect(body.configPath).toBe(configPath());
  expect(body.service.installed).toBe(true);
  expect(res.out).not.toInclude(CANNED.nodeKey);
  expect(res.out).not.toInclude("nsk_test_");
});

test("--json --no-service reports the skip rather than a silent false", async () => {
  const url = plane();
  const s = serviceStub();
  const res = await run(setupArgv(url, "--json", "--no-service"), { service: s.deps });
  const body = JSON.parse(res.out) as { service: { installed: boolean; reason?: string } };
  expect(body.service).toEqual({ installed: false, reason: "declined" });
  expect(s.calls).toEqual([]);
});
