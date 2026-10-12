import { expect, test } from "bun:test";
import { generateLinkKeyPair } from "@internal/subshell-protocol/node-link-crypto";
import { sealRouteRequest } from "@internal/subshell-protocol/node-route";
import { Elysia } from "elysia";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { authenticateNodeUpgrade } from "@/services/nodes/node-ws-handler.js";
import { createRouteDiscoveryRoute, type RouteDiscoveryDeps } from "../route-discovery.route.js";

async function fixture() {
  const keys = await generateLinkKeyPair();
  const nodeKeys = await generateLinkKeyPair();
  const state = { disabled: false, revoked: false, pin: nodeKeys.publicKey };
  const deps: RouteDiscoveryDeps = {
    keys: async () => keys,
    origins: () => ["http://172.16.2.177:3080", "http://127.0.0.1:3080", "http://8.8.8.8:3080"],
    auth: {
      verifyApiKey: async (key) =>
        key === "secret" && !state.revoked ? { id: "key", metadata: { kind: "node", nodeId: "node" } } : null,
      accountDisabled: async () => state.disabled,
      nodes: {
        findById: async () =>
          ({
            id: "node",
            apiKeyId: "key",
            kind: "agent",
            ownerUserId: "owner",
            encryptPublicKey: state.pin,
          }) as NodeTable,
        applyReady: async () => undefined,
        applyInventory: async () => undefined,
        touch: async () => undefined,
        setStatus: async () => undefined,
      },
    },
  };
  const app = new Elysia()
    .use(errorHandlerPlugin)
    .group("/api/nodes", (app) => app.use(createRouteDiscoveryRoute(deps)));
  async function probe(patch: Record<string, unknown> = {}) {
    const request = await sealRouteRequest(keys.publicKey, {
      purpose: "node-route-v1",
      nodeKey: "secret",
      nodeId: "node",
      nodePublicKey: nodeKeys.publicKey,
      ...patch,
    });
    const response = await app.handle(
      new Request("http://localhost/api/nodes/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.envelope),
      }),
    );
    return { response, request };
  }
  return { state, deps, probe };
}

test("encrypted HTTP discovery returns bounded private routes and a one-use WebSocket credential", async () => {
  const f = await fixture();
  const { response, request } = await f.probe();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const ciphertext = await response.text();
  expect(ciphertext).not.toContain("172.16");
  expect(ciphertext).not.toContain("secret");
  const reply = request.openReply(ciphertext) as { ticket: string; candidates: string[] };
  expect(reply.candidates).toEqual(["ws://172.16.2.177:3080/ws/node"]);
  const identity = await authenticateNodeUpgrade(f.deps.auth, `NodeRoute ${reply.ticket}`);
  expect(identity.nodeId).toBe("node");
  expect(identity.linkMode).toBe("handshake");
  await expect(authenticateNodeUpgrade(f.deps.auth, `NodeRoute ${reply.ticket}`)).rejects.toThrow();
});

test("discovery refuses wrong identity, wrong key, disabled owners and unpaired nodes", async () => {
  const f = await fixture();
  expect((await f.probe({ nodeId: "other" })).response.status).toBe(403);
  expect((await f.probe({ nodeKey: "wrong" })).response.status).toBe(401);
  f.state.disabled = true;
  expect((await f.probe()).response.status).toBe(403);
  f.state.disabled = false;
  f.state.pin = "";
  expect((await f.probe()).response.status).toBe(403);
});

test("ticket redemption rechecks revocation, ownership status and the pairing", async () => {
  for (const change of ["disabled", "revoked", "pin"] as const) {
    const f = await fixture();
    const { request, response } = await f.probe();
    const reply = request.openReply(await response.text()) as { ticket: string };
    if (change === "pin") f.state.pin = "changed";
    else f.state[change] = true;
    await expect(authenticateNodeUpgrade(f.deps.auth, `NodeRoute ${reply.ticket}`)).rejects.toThrow();
  }
});
