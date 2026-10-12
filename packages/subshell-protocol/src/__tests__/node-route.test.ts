import { expect, test } from "bun:test";
import { generateLinkKeyPair } from "../node-link-crypto.js";
import { isPrivateNodeRoute, openRouteRequest, routeDiscoveryUrl, sealRouteRequest } from "../node-route.js";

test("route probes protect credentials and authenticate only this pinned server and exchange", async () => {
  const server = await generateLinkKeyPair();
  const other = await generateLinkKeyPair();
  const request = await sealRouteRequest(server.publicKey, { nodeKey: "secret-node-key" });
  expect(JSON.stringify(request.envelope)).not.toContain("secret-node-key");
  await expect(openRouteRequest(other, request.envelope)).rejects.toThrow();
  const opened = await openRouteRequest(server, request.envelope);
  expect(opened.payload).toEqual({ nodeKey: "secret-node-key" });
  const reply = opened.sealReply({ ticket: "one-use" });
  const unrelated = await sealRouteRequest(server.publicKey, {});
  expect(() => unrelated.openReply(reply)).toThrow();
  expect(request.openReply(reply)).toEqual({ ticket: "one-use" });
  expect(() => request.openReply(reply)).toThrow();
});

test("discovery preserves proxy prefixes and refuses unrelated WebSocket paths", () => {
  expect(routeDiscoveryUrl("wss://plane.example/prefix/ws/node")).toBe("https://plane.example/prefix/api/nodes/route");
  expect(() => routeDiscoveryUrl("https://plane.example/ws/node")).toThrow();
});

test("automatic candidates exclude public hosts, loopback, metadata, credentials and unexpected paths", () => {
  for (const host of ["10.1.2.3", "172.16.2.177", "192.168.1.2", "100.118.1.1"]) {
    expect(isPrivateNodeRoute(`ws://${host}:3080/ws/node`)).toBe(true);
  }
  for (const url of [
    "ws://127.0.0.1/ws/node",
    "ws://169.254.169.254/ws/node",
    "ws://8.8.8.8/ws/node",
    "ws://host.local/ws/node",
    "ws://10.0.0.1/other",
    "ws://user:pass@10.0.0.1/ws/node",
    "ws://10.0.0.1/ws/node?q=x",
  ]) {
    expect(isPrivateNodeRoute(url)).toBe(false);
  }
});
