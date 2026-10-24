import { describe, expect, it } from "bun:test";
import { ApiError } from "../api-client.js";
import { createSubshell, listNodes } from "../subshell-tools.js";
import type { ToolDeps } from "../tools.js";
import { getNode, listSubshellViews, openSubshellView, ScreenSchema, watchSubshellBrowser } from "../view-tools.js";

const node = {
  id: "linux-1",
  name: "Linux",
  kind: "agent",
  status: "online",
  os: "linux",
  access: "owner",
  canLaunch: true,
  maintenance: false,
  inventoryStale: false,
  harnesses: [],
};
function fixture(answer: (path: string, init?: { method?: string; body?: unknown }) => unknown) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const deps: ToolDeps = {
    own: { principalId: "sess:test", publicJwk: "{}", privateJwk: "{}" },
    api: {
      async req<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        return answer(path, init) as T;
      },
    },
  };
  return { deps, calls };
}

describe("MCP preview discovery and launch", () => {
  it("preserves capability settings and honest harness health", async () => {
    const facts = {
      viewsEnabled: false,
      sshEnabled: true,
      sshWideForwards: false,
      protocolVersion: 17,
      agentVersion: "1",
      held: null,
      capabilities: ["uploads"],
      inventoryStale: true,
      harnesses: [
        {
          harnessId: "codex",
          name: "Codex",
          installed: true,
          version: "2",
          broken: "load failed",
          restartRequired: true,
          checkedAt: "yesterday",
        },
      ],
    };
    const { deps } = fixture(() => ({ nodes: [{ ...node, ...facts }] }));
    expect((await listNodes(deps))[0]).toMatchObject(facts);
  });
  it("checks requirements through the owner read surface, never management detail", async () => {
    const { deps, calls } = fixture((path) =>
      path === "/api/nodes" ? { nodes: [node] } : { supported: true, missing: ["xauth"] },
    );
    expect(await getNode(deps, { node: "linux" })).toMatchObject({
      id: node.id,
      virtualDisplay: { status: "missing-programs", missing: ["xauth"] },
    });
    expect(calls.at(-1)?.path).toBe("/api/nodes/linux-1/display-readiness");
    expect(calls.every((c) => c.path === "/api/nodes" || c.path.endsWith("/display-readiness"))).toBe(true);
  });
  it("doesn't confuse unsupported, offline, or unchecked with ready", async () => {
    for (const [changes, args, status] of [
      [{ os: "darwin" }, {}, "unsupported"],
      [{ status: "offline" }, {}, "unavailable"],
      [{}, { check_display: false }, "unchecked"],
    ] as const) {
      const { deps, calls } = fixture(() => ({ nodes: [{ ...node, ...changes }] }));
      expect((await getNode(deps, { node: node.id, ...args })).virtualDisplay.status).toBe(status);
      expect(calls.every((c) => c.path === "/api/nodes")).toBe(true);
    }
  });
  it("propagates permission failures and rejects malformed readiness", async () => {
    for (const status of [401, 403, 404]) {
      const { deps } = fixture((path) => {
        if (path === "/api/nodes") return { nodes: [node] };
        throw new ApiError(status, "Denied");
      });
      await expect(getNode(deps, { node: node.id })).rejects.toThrow("Denied");
    }
    const { deps } = fixture((path) => (path === "/api/nodes" ? { nodes: [node] } : {}));
    await expect(getNode(deps, { node: node.id })).rejects.toThrow("invalid display readiness");
  });
  it("keeps an unavailable probe distinct from missing programs", async () => {
    const { deps } = fixture((path) => {
      if (path === "/api/nodes") return { nodes: [node] };
      throw new ApiError(409, "Offline");
    });
    expect((await getNode(deps, { node: node.id })).virtualDisplay.status).toBe("unavailable");
  });
  it("forwards screen dimensions in both launch paths", async () => {
    for (const preset of [undefined, "preset-1"]) {
      const { deps, calls } = fixture((path) => {
        if (path === "/api/plugins")
          return { plugins: [{ id: "terminal", type: "terminal", installed: true, enabled: true }] };
        if (path === "/api/presets")
          return [{ id: preset, harnessId: "terminal", workingDir: "/work", promptBlocks: null }];
        if (path === "/api/nodes") return { nodes: [node] };
        return { id: "helper", promptDelivered: false };
      });
      await createSubshell(deps, {
        name: "Browser",
        harness: "terminal",
        preset,
        node: node.id,
        screen: { width: 1280, height: 800 },
      });
      expect(calls.at(-1)?.body).toMatchObject({ nodeId: node.id, screen: { width: 1280, height: 800 } });
    }
    expect(ScreenSchema.safeParse({ width: 100000, height: 800 }).success).toBe(false);
  });
  it("discovers and opens only the requested app or actual display port", async () => {
    const { deps, calls } = fixture((path) =>
      path.endsWith("/open")
        ? { proxyBase: "/preview/secret/" }
        : { nodeEnabled: true, screen: { display: ":90", rfbPort: 5900 }, ports: [] },
    );
    await listSubshellViews(deps, { subshell_id: "a/b" });
    expect(calls[0].path).toBe("/api/subshells/a%2Fb/views");
    expect(await openSubshellView(deps, { subshell_id: "a/b", kind: "screen" })).toMatchObject({
      port: 5900,
      proxyBase: "/preview/secret/",
    });
    expect(calls.at(-1)?.body).toEqual({ port: 5900 });
    await openSubshellView(deps, { subshell_id: "a/b", kind: "app", port: 3000 });
    expect(calls.at(-1)?.body).toEqual({ port: 3000 });
  });
  it("doesn't open a capability for an absent display or absent app port", async () => {
    const { deps, calls } = fixture(() => ({ nodeEnabled: true, screen: null }));
    await expect(openSubshellView(deps, { subshell_id: "x", kind: "screen" })).rejects.toThrow(
      "no available virtual display",
    );
    await expect(openSubshellView(deps, { subshell_id: "x", kind: "app" })).rejects.toThrow("require a port");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("starts and stops browser interest through the existing API", async () => {
    const { deps, calls } = fixture(() => ({ ok: true }));
    await watchSubshellBrowser(deps, { subshell_id: "x", on: true, port: 9222 });
    await watchSubshellBrowser(deps, { subshell_id: "x", on: false });
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["POST", { port: 9222 }],
      ["DELETE", undefined],
    ]);
  });
});
