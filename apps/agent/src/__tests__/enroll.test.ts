import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type CliResult, run } from "../cli.js";
import { configPath, loadConfig } from "../config.js";
import { mapOs } from "../enroll.js";
import { newHome } from "../test-preload.js";
import { AGENT_VERSION } from "../version.js";

/** The canned 201 the real route sends (spec §5.2). */
const CANNED = {
  nodeId: "node_test_1",
  nodeKey: "mote_key_never_printed",
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

function enrollArgv(serverUrl: string): string[] {
  return ["enroll", "--server", serverUrl, "--key", "nsk_test_0123456789", "--data-dir", dataDir];
}

test("enroll posts the route-shaped body, persists config at 0600, exits 0", async () => {
  let seen: Record<string, unknown> | undefined;
  let path: string | undefined;
  const url = fakeControlPlane(async (req) => {
    path = new URL(req.url).pathname;
    seen = (await req.json()) as Record<string, unknown>;
    return Response.json(CANNED, { status: 201 });
  });

  const res: CliResult = await run(enrollArgv(url));
  expect(res.code).toBe(0);
  expect(res.out).toInclude("Enrolled as node_test_1");
  expect(path).toBe("/api/nodes/enroll");

  // Body must match EnrollBodySchema field names and the route's os vocabulary.
  expect(Object.keys(seen ?? {}).sort()).toEqual(
    ["agentVersion", "arch", "hostname", "name", "os", "publicKey", "setupKey"].sort(),
  );
  expect((["linux", "darwin", "unknown"] as unknown[]).includes(seen?.os)).toBe(true);
  expect(seen?.os).toBe(mapOs(process.platform));
  expect(seen?.name).toBe(hostname()); // --name omitted → hostname default
  expect(seen?.hostname).toBe(hostname());
  expect(seen?.setupKey).toBe("nsk_test_0123456789");
  expect(seen?.agentVersion).toBe(AGENT_VERSION);
  const pub = JSON.parse(String(seen?.publicKey));
  expect(pub).toMatchObject({ kty: "EC", crv: "P-256" });
  expect("d" in pub).toBe(false);

  const cfg = await loadConfig();
  expect(cfg).toEqual({
    serverUrl: url,
    nodeId: CANNED.nodeId,
    nodeKey: CANNED.nodeKey,
    controlPublicKey: CANNED.controlPublicKey,
    dataDir,
    name: hostname(),
  });
  expect(existsSync(join(dataDir, "identity.json"))).toBe(true);

  // The secret never appears in CLI output.
  expect(`${res.out}${res.err}`).not.toInclude(CANNED.nodeKey);
  expect(`${res.out}${res.err}`).not.toInclude("nsk_test_");
});

test("401 maps to an actionable setup-key message and writes NO config", async () => {
  const url = fakeControlPlane(() =>
    Response.json({ message: "Setup key is invalid, expired, or already used." }, { status: 401 }),
  );
  const res = await run(enrollArgv(url));
  expect(res.code).toBe(1);
  expect(res.err.toLowerCase()).toInclude("setup key");
  expect(existsSync(configPath())).toBe(false);
});

test("409 surfaces the server message (name taken)", async () => {
  const url = fakeControlPlane(() =>
    Response.json({ message: `You already have a node named "${hostname()}"` }, { status: 409 }),
  );
  const res = await run(enrollArgv(url));
  expect(res.code).toBe(1);
  expect(res.err).toInclude("already have a node named");
  expect(existsSync(configPath())).toBe(false);
});

test("tmux preflight fails BEFORE any network call (ENOENT path), with a hint", async () => {
  let hits = 0;
  const url = fakeControlPlane(() => {
    hits++;
    return Response.json(CANNED, { status: 201 });
  });
  const savedSkip = process.env.MOTE_AGENT_SKIP_TMUX_CHECK;
  delete process.env.MOTE_AGENT_SKIP_TMUX_CHECK;
  // Deterministic ENOENT regardless of what the host has installed (Bun falls
  // back to a default search path when PATH is empty, so the PATH trick lies).
  const realSpawnSync = Bun.spawnSync;
  const spawned: string[][] = [];
  try {
    Bun.spawnSync = ((cmd: string[]) => {
      spawned.push(cmd);
      return {
        exitCode: null,
        success: false,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      };
    }) as unknown as typeof Bun.spawnSync;
    const res = await run(enrollArgv(url));
    expect(spawned).toEqual([["tmux", "-V"]]);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("tmux not found");
    expect(hits).toBe(0); // no request reached the control plane
    expect(existsSync(configPath())).toBe(false);
  } finally {
    Bun.spawnSync = realSpawnSync;
    if (savedSkip !== undefined) process.env.MOTE_AGENT_SKIP_TMUX_CHECK = savedSkip;
  }
});

test("tmux preflight passes when the probe succeeds", async () => {
  const savedSkip = process.env.MOTE_AGENT_SKIP_TMUX_CHECK;
  delete process.env.MOTE_AGENT_SKIP_TMUX_CHECK;
  const realSpawnSync = Bun.spawnSync;
  try {
    Bun.spawnSync = (() => ({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    })) as unknown as typeof Bun.spawnSync;
    const url = fakeControlPlane(() => Response.json(CANNED, { status: 201 }));
    const res = await run(enrollArgv(url));
    expect(res.code).toBe(0);
  } finally {
    Bun.spawnSync = realSpawnSync;
    if (savedSkip !== undefined) process.env.MOTE_AGENT_SKIP_TMUX_CHECK = savedSkip;
  }
});

test("unreachable control plane → code 1, no config, no stack trace", async () => {
  const res = await run(enrollArgv("http://127.0.0.1:1"));
  expect(res.code).toBe(1);
  expect(res.err.length).toBeGreaterThan(0);
  expect(res.err.split("\n").filter((l) => l.trim().length > 0).length).toBe(1); // a single actionable line, no stack trace
  expect(existsSync(configPath())).toBe(false);
});

test("name pre-flight: >64-char --name fails with NO request, message names --name", async () => {
  let hits = 0;
  const url = fakeControlPlane(() => {
    hits++;
    return Response.json(CANNED, { status: 201 });
  });
  const res = await run([...enrollArgv(url), "--name", "n".repeat(65)]);
  expect(res.code).toBe(1);
  expect(hits).toBe(0); // the cap is caught before any network call
  expect(res.err).toInclude("--name");
  expect(res.err).toInclude("64");
  expect(existsSync(configPath())).toBe(false);
});

test("server 400 with validationError details surfaces the field message", async () => {
  // Mirrors what the real route sends for a too-short setup key (the agent
  // deliberately does NOT pre-check key length): Elysia's VALIDATION error,
  // rewritten by the backend's error-handler plugin into a 400 whose body
  // carries validationError.validation[] items with `path` + `message`.
  const url = fakeControlPlane(() =>
    Response.json(
      {
        errId: "err_test123456",
        code: "INPUT_VALIDATION_ERROR",
        message: "Validation Error",
        statusCode: 400,
        validationError: {
          validation: [
            {
              summary: "Expected string length greater or equal to 8",
              path: "/setupKey",
              message: "Expected string length greater or equal to 8",
            },
          ],
          validationContext: "body",
          message: "Validation Error",
        },
      },
      { status: 400 },
    ),
  );
  const res = await run(["enroll", "--server", url, "--key", "short", "--data-dir", dataDir]);
  expect(res.code).toBe(1);
  expect(res.err).toInclude("setupKey: Expected string length greater or equal to 8");
  expect(existsSync(configPath())).toBe(false);
});

test("missing required flags → usage, exit 2", async () => {
  const res = await run(["enroll", "--server", "http://x"]);
  expect(res.code).toBe(2);
  expect(res.err).toInclude("usage");
});

test("unknown command and unknown flag → usage on stderr, exit 2", async () => {
  expect((await run(["frobnicate"])).code).toBe(2);
  const badFlag = await run(["status", "--nope"]);
  expect(badFlag.code).toBe(2);
  expect(badFlag.err).toInclude("usage");
});

test("run is a stub this task: message + exit 3 (T13 replaces it)", async () => {
  const res = await run(["run"]);
  expect(res.code).toBe(3);
  expect(res.err).toInclude("phase 1 task 13");
});

test("version prints agent version + node protocol version", async () => {
  const res = await run(["version"]);
  expect(res.code).toBe(0);
  expect(res.out).toInclude("0.1.0");
  expect(res.out).toInclude("protocol v1");
});

test("status shows the enrollment without the node key; --json omits nodeKey too", async () => {
  const url = fakeControlPlane(() => Response.json(CANNED, { status: 201 }));
  expect((await run(enrollArgv(url))).code).toBe(0);

  const human = await run(["status"]);
  expect(human.code).toBe(0);
  expect(human.out).toInclude("node_test_1");
  expect(human.out).not.toInclude(CANNED.nodeKey);

  const json = await run(["status", "--json"]);
  expect(json.code).toBe(0);
  const parsed = JSON.parse(json.out);
  expect(parsed.nodeId).toBe("node_test_1");
  expect("nodeKey" in parsed).toBe(false);
});

test("status without a config → code 1 pointing at enroll", async () => {
  newHome();
  const res = await run(["status"]);
  expect(res.code).toBe(1);
  expect(res.err.toLowerCase()).toInclude("enroll");
});
