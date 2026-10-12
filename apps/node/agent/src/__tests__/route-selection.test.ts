import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLinkKeyPair } from "@internal/subshell-protocol/node-link-crypto";
import { openRouteRequest, type RouteEnvelope } from "@internal/subshell-protocol/node-route";
import type { NodeConfig } from "../config.js";
import { NodeRouteSelector } from "../route-selection.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const publicUrl = "wss://plane.example/ws/node";
const lan = "ws://172.16.2.177:3080/ws/node";

async function fixture() {
  const server = await generateLinkKeyPair();
  const stranger = await generateLinkKeyPair();
  const dir = await mkdtemp(join(tmpdir(), "node-route-test-"));
  dirs.push(dir);
  const config: NodeConfig = {
    nodeId: "node",
    nodeKey: "secret-key",
    name: "test",
    serverUrl: "https://plane.example",
    controlPublicKey: "{}",
    controlEncryptPublicKey: server.publicKey,
    encryptKeyPair: await generateLinkKeyPair(),
    dataDir: dir,
  };
  const calls: string[] = [];
  const state = { publicDown: false, lanDown: false, wrongIdentity: false, lanDelay: 2, publicDelay: 65 };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(init?.body).not.toContain("secret-key");
    const local = url.includes("172.16.");
    if (local ? state.lanDown : state.publicDown) throw new Error("unreachable");
    const request = await openRouteRequest(server, JSON.parse(String(init?.body)) as RouteEnvelope);
    expect(request.payload).toMatchObject({ nodeKey: "secret-key" });
    await Bun.sleep(local ? state.lanDelay : state.publicDelay);
    if (local && state.wrongIdentity) {
      // An unrelated control plane cannot even open the probe, much less authenticate its reply.
      await openRouteRequest(stranger, JSON.parse(String(init?.body)) as RouteEnvelope);
    }
    return new Response(
      request.sealReply({
        purpose: "node-route-v1",
        candidates: [lan, "ws://evil.example/ws/node"],
        ticket: crypto.randomUUID() + crypto.randomUUID(),
      }),
    );
  }) as typeof fetch;
  return { config, state, calls, selector: () => new NodeRouteSelector(config, publicUrl, { fetch: fetcher }) };
}

test("prefers a verified faster LAN route without rewriting the public fallback", async () => {
  const f = await fixture();
  const route = await f.selector().select();
  expect(route.url).toBe(lan);
  expect(route.authorization).toStartWith("NodeRoute ");
  expect(f.config.serverUrl).toBe("https://plane.example");
  expect(f.calls.some((url) => url.includes("evil"))).toBe(false);
});

test("unreachable and wrong-identity LAN endpoints fall back without receiving a plaintext credential", async () => {
  const f = await fixture();
  f.state.wrongIdentity = true;
  expect((await f.selector().select()).url).toBe(publicUrl);
  f.state.wrongIdentity = false;
  f.state.lanDown = true;
  expect((await f.selector().select()).url).toBe(publicUrl);
});

test("cached hints allow a fresh daemon to reach LAN while the public endpoint is down", async () => {
  const f = await fixture();
  await f.selector().select();
  f.state.publicDown = true;
  expect((await f.selector().select()).url).toBe(lan);
  // A different pinned identity cannot reuse the old cache.
  f.config.controlEncryptPublicKey = (await generateLinkKeyPair()).publicKey;
  expect((await f.selector().select()).url).toBe(publicUrl);
});

test("a failed WebSocket route cools down and returns to the configured endpoint", async () => {
  const f = await fixture();
  const selector = f.selector();
  selector.failed(await selector.select());
  expect((await selector.select()).url).toBe(publicUrl);
});

test("a small timing difference keeps the configured route", async () => {
  const f = await fixture();
  f.state.publicDelay = 8;
  expect(await f.selector().select()).toMatchObject({
    url: publicUrl,
    authorization: "Bearer secret-key",
    automatic: false,
  });
});

test("older servers and unpaired nodes keep the configured behavior", async () => {
  const f = await fixture();
  f.state.publicDown = true;
  const route = await f.selector().select();
  expect(route).toEqual({ url: publicUrl, authorization: "Bearer secret-key", automatic: false });
  f.config.controlEncryptPublicKey = undefined;
  f.calls.length = 0;
  await f.selector().select();
  expect(f.calls).toEqual([]);
});
