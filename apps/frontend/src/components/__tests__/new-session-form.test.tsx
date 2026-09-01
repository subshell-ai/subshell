import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  canSubmit,
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
  pickNodeDefault,
} from "@/components/session-picker/new-session-form";
import type { Node } from "@/types/node";

/**
 * The node picker on the shared new-session form (spec 2026-08-31 §9, §6.6):
 * any visible node is a launch target, offline agents are shown but not
 * selectable, the default is `local`, and a remote pick is REAL — the form
 * offers it without any phase-1 caveat (the id posts as-is; see
 * `create-session.test`).
 */
function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

const LOCAL = node({ id: "local", name: "this host", kind: "local", access: "view" });
const AGENT_ONLINE = node({ id: "a1", name: "mac mini", status: "online" });
const AGENT_OFFLINE = node({ id: "a2", name: "old laptop", status: "offline" });

function mockFetch(nodes: Node[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/profiles") return Promise.resolve(new Response(JSON.stringify([])));
    if (path === "/api/files/recent") return Promise.resolve(new Response(JSON.stringify({ paths: [] })));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** The form is fully caller-controlled; this harness owns the state it would. */
function renderForm(initial: NewSessionFormValue = emptyNewSessionForm()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: NewSessionFormValue = initial;
  function Harness() {
    const [value, setValue] = useState<NewSessionFormValue>(initial);
    latest = value;
    return <NewSessionForm value={value} onChange={setValue} />;
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { latest: () => latest };
}

afterEach(cleanup);

describe("pickNodeDefault", () => {
  it("keeps a valid pick and the local default while local is present", () => {
    const nodes = [LOCAL, AGENT_ONLINE, AGENT_OFFLINE];
    expect(pickNodeDefault(nodes, "local")).toBe("local");
    expect(pickNodeDefault(nodes, "a1")).toBe("a1");
  });

  it("falls to the sole selectable option when local vanished", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_OFFLINE], "local")).toBe("a1");
  });

  it("forces an explicit choice when local vanished and several nodes remain", () => {
    expect(pickNodeDefault([AGENT_ONLINE, node({ id: "a3", name: "studio" })], "local")).toBe("");
  });
});

describe("NewSessionForm node picker", () => {
  it("defaults to Local and stays submittable", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE, AGENT_OFFLINE]);
    try {
      const { latest } = renderForm();
      expect(await screen.findByText("Local")).toBeDefined();
      await waitFor(() => expect(latest().nodeId).toBe("local"));
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" })).toBe(true);
    } finally {
      restore();
    }
  });

  it("offers a remote node with NO phase-1 caveat — remote launch is real", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "a1" });
      // The pick stands (no notice, no normalisation): the id posts as-is
      // (belt pinned in create-session.test) and the server gates it.
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      expect(screen.queryByText(/phase 2/i)).toBeNull();
      expect(screen.queryByText(/control-plane host/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("drops to an empty selection (no submit) when local is gone and a choice is due", async () => {
    const restore = mockFetch([AGENT_ONLINE, node({ id: "a3", name: "studio" })]);
    try {
      const { latest } = renderForm();
      await waitFor(() => expect(latest().nodeId).toBe(""));
      expect(screen.getByText("Choose a node")).toBeDefined();
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" })).toBe(false);
    } finally {
      restore();
    }
  });
});
