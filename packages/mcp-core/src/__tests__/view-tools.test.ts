import { describe, expect, it } from "bun:test";
import { ApiError } from "../api-client.js";
import { createSubshell, listNodes } from "../subshell-tools.js";
import type { ToolDeps } from "../tools.js";
import {
  getNode,
  listSubshellViews,
  OpenSubshellViewSchema,
  openSubshellView,
  ScreenSchema,
  watchSubshellBrowser,
} from "../view-tools.js";

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
  it("reports local helper consent as unmet even when the node enables BetterDisplay", async () => {
    const missing = ["Enable Virtual Display Helper in the desktop app on this node (macOS 14 or later)"];
    const { deps, calls } = fixture((path) =>
      path === "/api/nodes"
        ? {
            nodes: [
              {
                ...node,
                os: "darwin",
                virtualDisplayEnabled: true,
                virtualDisplayProvider: "betterdisplay",
                virtualDisplayProviders: ["betterdisplay"],
              },
            ],
          }
        : { supported: true, missing },
    );
    expect(await getNode(deps, { node: node.id, provider: "betterdisplay" })).toMatchObject({
      virtualDisplay: { enabled: true, provider: "betterdisplay", status: "missing-programs", missing },
    });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.at(-1)?.path).toBe(`/api/nodes/${node.id}/display-readiness?provider=betterdisplay`);
  });
  it("calls a provider outside the catalog disabled, the way create refuses it", async () => {
    // The route that writes this list checks it against the catalog, so a row
    // reaching an id this build does not ship arrives by some other door: a
    // hand-edit, a restore, or a later release shrinking the catalog out from
    // under a stored value. `resolveNodeDisplayRequest` refuses it at create
    // with `preview-display-unsupported` whatever its source, so this mirrors
    // that check rather than the writer's, and an agent is never told a thing is
    // ready by the same tool that would recommend the launch which 400s.
    const stored = ["xvfb-x11vnc", "my-x11-thing"];
    const { deps } = fixture((path) =>
      path === "/api/nodes"
        ? {
            nodes: [
              {
                ...node,
                os: "linux",
                virtualDisplayEnabled: true,
                virtualDisplayProvider: "my-x11-thing",
                virtualDisplayProviders: stored,
              },
            ],
          }
        : { supported: false, missing: [] },
    );
    const asDefault = await getNode(deps, { node: node.id });
    expect(asDefault.virtualDisplay).toMatchObject({ provider: "my-x11-thing", enabled: false });
    // Asked for explicitly, same answer; and a catalog provider on the same node
    // is still enabled, so this is the id being refused, not the node.
    const asAsk = await getNode(deps, { node: node.id, provider: "my-x11-thing" });
    expect(asAsk.virtualDisplay).toMatchObject({ provider: "my-x11-thing", enabled: false });
    const bundled = await getNode(deps, { node: node.id, provider: "xvfb-x11vnc" });
    expect(bundled.virtualDisplay).toMatchObject({ provider: "xvfb-x11vnc", enabled: true });
  });

  it("preserves capability settings and honest harness health", async () => {
    const facts = {
      webPreviewsEnabled: false,
      virtualDisplayEnabled: true,
      virtualDisplayProvider: "xvfb-x11vnc",
      virtualDisplayProviders: ["xvfb-x11vnc", "native-example"],
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
  it("reports disabled permission even when display prerequisites are ready", async () => {
    const { deps } = fixture((path) =>
      path === "/api/nodes"
        ? { nodes: [{ ...node, webPreviewsEnabled: true, virtualDisplayEnabled: false }] }
        : { supported: true, missing: [] },
    );
    expect(await getNode(deps, { node: node.id })).toMatchObject({
      webPreviewsEnabled: true,
      virtualDisplayEnabled: false,
      virtualDisplay: { status: "ready", enabled: false },
    });
    const views = fixture(() => ({
      nodeEnabled: true,
      webPreviewsEnabled: true,
      virtualDisplayEnabled: false,
      ports: [],
      cdpPort: null,
      screen: null,
    }));
    expect(await listSubshellViews(views.deps, { subshell_id: "x" })).toMatchObject({
      webPreviewsEnabled: true,
      virtualDisplayEnabled: false,
    });
  });

  it("reports a requested provider's policy separately from its readiness", async () => {
    const { deps, calls } = fixture((path) =>
      path === "/api/nodes"
        ? { nodes: [{ ...node, virtualDisplayEnabled: true, virtualDisplayProviders: ["xvfb-x11vnc"] }] }
        : { supported: true, missing: [] },
    );
    expect(await getNode(deps, { node: node.id, provider: "native-example" })).toMatchObject({
      virtualDisplay: { provider: "native-example", enabled: false, status: "ready" },
    });
    expect(calls.at(-1)?.path).toBe("/api/nodes/linux-1/display-readiness?provider=native-example");
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
      const { deps, calls } = fixture((path) =>
        path === "/api/nodes" ? { nodes: [{ ...node, ...changes }] } : { supported: false, missing: [] },
      );
      expect((await getNode(deps, { node: node.id, ...args })).virtualDisplay.status).toBe(status);
      expect(
        calls.every(
          (c) => c.path === "/api/nodes" || (status === "unsupported" && c.path.endsWith("/display-readiness")),
        ),
      ).toBe(true);
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
        screen: { width: 1280, height: 800, provider: "native-example" },
      });
      expect(calls.at(-1)?.body).toMatchObject({
        nodeId: node.id,
        screen: { width: 1280, height: 800, provider: "native-example" },
      });
    }
    expect(ScreenSchema.safeParse({ width: 100000, height: 800 }).success).toBe(false);
  });
  it("discovers and opens only the requested app or actual display port", async () => {
    const { deps, calls } = fixture((path) =>
      path.endsWith("/open")
        ? { proxyBase: "/preview/secret/" }
        : { nodeEnabled: true, screen: { display: ":90", viewer: { protocol: "vnc", port: 5900 } }, ports: [] },
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
  it("explains a disabled display without trying to open it", async () => {
    const { deps, calls } = fixture(() => ({
      nodeEnabled: true,
      webPreviewsEnabled: true,
      virtualDisplayEnabled: false,
      screen: null,
    }));
    await expect(openSubshellView(deps, { subshell_id: "x", kind: "screen" })).rejects.toThrow(
      "virtual displays are disabled on this node",
    );
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("propagates node permission refusals for apps and browser watching", async () => {
    const { deps } = fixture(() => {
      throw new ApiError(409, "Web previews are disabled on this node.");
    });
    await expect(openSubshellView(deps, { subshell_id: "x", kind: "app", port: 3000 })).rejects.toThrow(
      "disabled on this node",
    );
    await expect(watchSubshellBrowser(deps, { subshell_id: "x", on: true })).rejects.toThrow("disabled on this node");
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

it("refuses ambiguous view arguments before opening a capability", () => {
  expect(OpenSubshellViewSchema.safeParse({ subshell_id: "p", kind: "app" }).success).toBe(false);
  expect(OpenSubshellViewSchema.safeParse({ subshell_id: "p", kind: "screen", port: 3000 }).success).toBe(false);
  expect(OpenSubshellViewSchema.safeParse({ subshell_id: "p", kind: "app", port: 3000 }).success).toBe(true);
  expect(OpenSubshellViewSchema.safeParse({ subshell_id: "p", kind: "screen" }).success).toBe(true);
});
