/**
 * Real server + enrolled daemon on isolated Docker networks, with a delayed
 * public proxy. Run after `bunx turbo build`:
 *   bun scripts/cli-e2e/node-routes-docker.ts
 * ROUTE_TEST_IMAGE must contain Bun and tmux (default desktop-builder:local).
 * No host config, service manager, credentials, or live server is used.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone fixture image override, outside turbo
const image = process.env.ROUTE_TEST_IMAGE ?? "desktop-builder:local";
const prefix = `subshell-routes-${process.pid}-${Date.now()}`;
const scratch = await mkdtemp(join(tmpdir(), "subshell-route-docker-"));
const containers: string[] = [];
const networks: string[] = [];
const reports: { scenario: string; route: string }[] = [];
const publicOrigin = "http://public:3199";
const nodeName = `${prefix}-node`;
const serverName = `${prefix}-server`;
const proxyName = `${prefix}-proxy`;
const lanNetwork = `${prefix}-lan`;
const publicNetwork = `${prefix}-public`;
const backhaulNetwork = `${prefix}-backhaul`;
let cookie = "";
let api = "";
let nodeId = "";

async function docker(...args: string[]): Promise<string> {
  const result = await exec("docker", args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
}
async function waitFor(check: () => Promise<boolean>, label: string, timeout = 45_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function request(path: string, body?: unknown): Promise<Response> {
  return fetch(`${api}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: publicOrigin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}
async function run(name: string, network: string, extra: string[], command: string[]): Promise<void> {
  containers.push(name);
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "--entrypoint",
    "bun",
    "--mount",
    `type=bind,source=${root},target=/workspace,readonly`,
    "--workdir",
    "/tmp",
    ...extra,
    image,
    ...command,
  );
}
const serverEnv = [
  "-e",
  "NODE_ENV=development",
  "-e",
  "SUBSHELL_TEST_MODE=false",
  "-e",
  "SERVER_PORT=3199",
  "-e",
  "HOST=0.0.0.0",
  "-e",
  `APP_BASE_URL=${publicOrigin}`,
  "-e",
  "SUBSHELL_SERVER_CONFIG_DIR=/tmp/server-config",
  "-e",
  "SUBSHELL_SERVER_DATA_DIR=/tmp/server-data",
  "-e",
  "DATABASE_PATH=/tmp/server.db",
  "-e",
  "SUBSHELL_RELEASE_URL=",
  "-e",
  "BETTER_AUTH_SECRET=container-route-fixture-only-0000000000000000",
];
async function restartNode(): Promise<void> {
  await docker("restart", "--time", "2", nodeName);
}
async function verifyRoute(scenario: string, pattern: RegExp): Promise<void> {
  let selected = "";
  const startedAt = await docker("inspect", "--format", "{{.State.StartedAt}}", nodeName);
  await waitFor(async () => {
    const logs = await docker("logs", "--since", startedAt, nodeName);
    selected =
      logs
        .split("\n")
        .filter((line) => line.includes("node connection:"))
        .at(-1) ?? "";
    if (!pattern.test(selected)) return false;
    const response = await request(`/api/nodes/${nodeId}`);
    if (!response.ok) return false;
    const body = (await response.json()) as { status: string; runtime?: { startedAt: string } };
    return body.status === "online" && !!body.runtime && Date.parse(body.runtime.startedAt) >= Date.parse(startedAt);
  }, scenario);
  reports.push({ scenario, route: selected });
  console.log(`PASS ${scenario}: ${selected}`);
}

try {
  for (const network of [lanNetwork, publicNetwork, backhaulNetwork]) {
    await docker("network", "create", network);
    networks.push(network);
  }
  await run(
    serverName,
    backhaulNetwork,
    ["--network-alias", "server", "-p", "127.0.0.1::3199", ...serverEnv],
    ["/workspace/apps/server/api/src/index.ts"],
  );
  await docker("network", "connect", lanNetwork, serverName);
  const published = await docker("port", serverName, "3199/tcp");
  api = `http://${published}`;
  await waitFor(async () => (await request("/api/setup/status")).ok, "server ready");
  const serverNetwork = JSON.parse(await docker("inspect", serverName)) as Array<{
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>;
  const lanIp = serverNetwork[0]?.NetworkSettings.Networks[lanNetwork]?.IPAddress;
  assert(lanIp, "server LAN address exists");
  await run(proxyName, backhaulNetwork, [], ["/workspace/scripts/cli-e2e/route-latency-proxy.ts"]);
  await docker("network", "connect", "--alias", "public", publicNetwork, proxyName);

  const signup = await request("/api/auth/sign-up/email", {
    email: "route-test@example.test",
    password: "route-fixture-password-12345",
    name: "Route test",
  });
  assert.equal(signup.status, 200, await signup.text());
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie, "fixture signup returned a session cookie");
  const keyResponse = await request("/api/nodes/setup-keys", {});
  assert.equal(keyResponse.status, 201);
  const setup = (await keyResponse.json()) as { key: string };
  // Keep the one-use fixture credential out of Docker command arguments and logs.
  const enrollment = join(scratch, "enrollment.json");
  await writeFile(enrollment, JSON.stringify({ key: setup.key }), { mode: 0o600 });
  await run(
    nodeName,
    publicNetwork,
    [
      "-e",
      "SUBSHELL_CONFIG_HOME=/tmp/node-config",
      "-e",
      "SUBSHELL_DASHBOARD=0",
      "--mount",
      `type=bind,source=${enrollment},target=/tmp/enrollment.json,readonly`,
    ],
    [
      "-e",
      `
    import { readFileSync } from "node:fs";
    // The CLI parser stays under test: execute it for enrollment, then the real daemon.
    if (!await Bun.file("/tmp/node-config/config.json").exists()) {
      const { key } = JSON.parse(readFileSync("/tmp/enrollment.json", "utf8"));
      const p = Bun.spawn(["bun", "/workspace/apps/node/agent/src/main.ts", "enroll", "--server", "${publicOrigin}", "--key", key, "--name", "Route fixture"], { stdout: "ignore", stderr: "inherit" });
      if (await p.exited !== 0) process.exit(1);
    }
    const p = Bun.spawn(["bun", "/workspace/apps/node/agent/src/main.ts", "run"], { stdout: "inherit", stderr: "inherit" });
    process.on("SIGTERM", () => p.kill("SIGTERM"));
    process.exit(await p.exited);
  `,
    ],
  );
  await docker("network", "connect", lanNetwork, nodeName);
  await waitFor(async () => {
    const response = await request("/api/nodes");
    if (!response.ok) return false;
    const body = (await response.json()) as { nodes: { id: string; name: string }[] };
    nodeId = body.nodes.find((node) => node.name === "Route fixture")?.id ?? "";
    return !!nodeId;
  }, "node enrolled");
  const direct = new RegExp(`direct route ws://${lanIp.replaceAll(".", "\\.")}:3199/ws/node`);
  await verifyRoute("prefers LAN over delayed public proxy", direct);

  await docker("network", "disconnect", lanNetwork, nodeName);
  await restartNode();
  await verifyRoute("falls back when LAN is unavailable", /configured route ws:\/\/public:3199\/ws\/node/);

  await docker("network", "connect", lanNetwork, nodeName);
  await restartNode();
  await verifyRoute("selects LAN again on reconnect", direct);

  await docker("stop", "--time", "2", proxyName);
  await restartNode();
  await verifyRoute("cached LAN works while public endpoint is down", direct);
  await docker("stop", "--time", "2", nodeName);
  await docker("start", proxyName);
  await docker("network", "disconnect", lanNetwork, serverName);
  const impostorName = `${prefix}-impostor`;
  await run(
    impostorName,
    lanNetwork,
    [
      "--ip",
      lanIp,
      ...serverEnv,
      "-e",
      "SERVER_PORT=3200",
      "-e",
      "ROUTE_PROXY_HOST=127.0.0.1",
      "-e",
      "ROUTE_PROXY_PORT=3200",
      "-e",
      "ROUTE_PROXY_DELAY_MS=0",
      "-e",
      "ROUTE_PROXY_AUDIT=1",
    ],
    [
      "-e",
      `
      const server = Bun.spawn(["bun", "/workspace/apps/server/api/src/index.ts"], { stdout: "inherit", stderr: "inherit" });
      const proxy = Bun.spawn(["bun", "/workspace/scripts/cli-e2e/route-latency-proxy.ts"], { stdout: "inherit", stderr: "inherit" });
      process.on("SIGTERM", () => { server.kill(); proxy.kill(); });
      await Promise.all([server.exited, proxy.exited]);
    `,
    ],
  );
  await waitFor(
    async () =>
      (await docker(
        "exec",
        impostorName,
        "bun",
        "-e",
        'const r = await fetch("http://127.0.0.1:3200/api/setup/status"); process.exit(r.ok ? 0 : 1)',
      )) === "",
    "impostor ready",
  );
  await docker("start", nodeName);
  await verifyRoute(
    "rejects another control plane at the cached LAN address",
    /configured route ws:\/\/public:3199\/ws\/node/,
  );
  const impostorLog = await docker("logs", impostorName);
  assert.match(impostorLog, /probe request: POST \/api\/nodes\/route HTTP\/1.1; authorization header: false/);
  assert.match(impostorLog, /probe response: HTTP\/1.1 401/);
  assert.doesNotMatch(impostorLog, /probe request: GET \/ws\/node/);
  console.log(
    "PASS wrong-identity server received encrypted discovery only, with no Authorization header or WebSocket upgrade",
  );
  const configured = await docker(
    "exec",
    nodeName,
    "bun",
    "-e",
    'console.log(JSON.parse(await Bun.file("/tmp/node-config/config.json").text()).serverUrl)',
  );
  assert.equal(configured, publicOrigin);
  console.log("PASS configured public address was preserved");
  console.log(JSON.stringify(reports, null, 2));
} catch (error) {
  for (const name of containers) {
    const logs = await docker("logs", "--tail", "35", name).catch(() => "unavailable");
    console.error(`${name}:\n${logs}`);
  }
  throw error;
} finally {
  for (const name of containers.reverse()) await docker("rm", "-f", name).catch(() => {});
  for (const network of networks.reverse()) await docker("network", "rm", network).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
