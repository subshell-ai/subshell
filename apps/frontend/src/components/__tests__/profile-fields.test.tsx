import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ProfileFields } from "@/components/profile-fields";
import { emptyProfileForm, type ProfileFormValue, toProfileUpdatePayload } from "@/lib/profile-form";
import type { HarnessInfo } from "@/types/harness";
import type { Node } from "@/types/node";

/**
 * The profile editor's node-pin fallback: a pin whose node is no longer in
 * the caller's visible list (deleted, or the share revoked since it was set)
 * is refused by the server on save, so the editor must show "Any node" AND
 * normalize the form value to the "" sentinel — saving any other field then
 * PUTs `nodeId: null`, never the ghost id.
 */
const claude: HarnessInfo = {
  id: "claude",
  name: "Claude",
  binary: "claude",
  description: "",
  installed: true,
  enabled: true,
  install: { command: "", docsUrl: "" },
};

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: "local",
    name: "this host",
    kind: "local",
    os: "linux",
    arch: "x64",
    hostname: "host",
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

function mockFetch(nodes: Node[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/setup/harnesses") return Promise.resolve(new Response(JSON.stringify([claude])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/**
 * Stateful controlled parent (like the create form / edit page): onChange
 * flows back into `value`, and every emitted value is recorded in `seen` so
 * the assertions can inspect what a save would PUT.
 */
function renderEditor(initial: ProfileFormValue, seen: ProfileFormValue[]) {
  function Wrapper() {
    const [value, setValue] = useState(initial);
    return (
      <ProfileFields
        value={value}
        lockHarness
        onChange={(v) => {
          seen.push(v);
          setValue(v);
        }}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Wrapper />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ProfileFields node pin", () => {
  it("normalizes a dead pin to '' (Any node) so the save payload sends nodeId null", async () => {
    const restore = mockFetch([node()]);
    try {
      const seen: ProfileFormValue[] = [];
      renderEditor({ ...emptyProfileForm(), harnessId: "claude", name: "P", nodeId: "ghost" }, seen);
      // The picker falls back to the "Any node (default)" row…
      await screen.findByText("Any node (default)");
      // …and the FORM value moved too — saving any field PUTs null, not "ghost".
      await waitFor(() => expect(seen.some((v) => v.nodeId === "")).toBe(true));
      const last = seen[seen.length - 1];
      expect(toProfileUpdatePayload(last).nodeId).toBeNull();
    } finally {
      restore();
    }
  });

  it("leaves a live pin alone once the list arrives (no unpin mid-load, no ghost-clear)", async () => {
    const restore = mockFetch([node(), node({ id: "agent1", name: "Alpha Box", kind: "agent", access: "edit" })]);
    try {
      const seen: ProfileFormValue[] = [];
      renderEditor({ ...emptyProfileForm(), harnessId: "claude", name: "P", nodeId: "agent1" }, seen);
      // The mapped label only renders after the list resolved the id — proof
      // the effect had its chance and correctly did nothing.
      await screen.findByText("Alpha Box");
      expect(seen).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
