import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  anchorDecision,
  canSubmit,
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
  pickNodeDefault,
} from "@/components/session-picker/new-session-form";
import { toSessionCreateBody } from "@/hooks/use-create-session";
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

/** One pinned-profile row; only the fields the form reads. */
function pinnedProfile(nodeId: string | null, name = "pinned prof") {
  return {
    id: "p1",
    harnessId: "claude-code",
    name,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    isDefault: 0,
    nodeId,
  };
}

function mockFetch(nodes: Node[], profiles: unknown[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/profiles") return Promise.resolve(new Response(JSON.stringify(profiles)));
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

/**
 * The pinned-profile re-anchor: profile.nodeId drags the picker onto its
 * node until the user overrides it, so the picker never reads "Local" while
 * the pin lands the session elsewhere. Wire rule untouched (spec §6.6):
 * anchored → forwarded id; explicit Local → omitted (the pin re-applies
 * server-side — visibly).
 */
describe("anchorDecision", () => {
  it("anchors to the pinned node while the user stays silent", () => {
    const d = anchorDecision({ pinRow: AGENT_ONLINE, explicit: false, current: "local", anchoredTo: null });
    expect(d).toEqual({ nodeId: "a1", anchoredTo: "a1" });
  });

  it("an explicit pick — Local included — outranks the anchor", () => {
    const d = anchorDecision({ pinRow: AGENT_ONLINE, explicit: true, current: "local", anchoredTo: "a1" });
    expect(d).toEqual({ nodeId: "local", anchoredTo: "a1" });
  });

  it("releases an unearned anchor back to local (only while it still owns the pick)", () => {
    expect(anchorDecision({ pinRow: null, explicit: false, current: "a1", anchoredTo: "a1" }).nodeId).toBe("local");
    // The user touched a node (or moved on) — the pick is theirs, not the
    // stale anchor's, and stays put.
    expect(anchorDecision({ pinRow: null, explicit: true, current: "a1", anchoredTo: "a1" }).nodeId).toBe("a1");
    expect(anchorDecision({ pinRow: null, explicit: false, current: "local", anchoredTo: "a1" }).nodeId).toBe("local");
  });
});

describe("NewSessionForm pinned-profile re-anchor", () => {
  it("anchors the selection to the pinned node and forwards its id on the wire", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE], [pinnedProfile("a1")]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      // The trigger shows the pin (honest picker) and the body forwards the
      // pinned id — explicit beats pin, same landing spot.
      expect(await screen.findByText("mac mini")).toBeDefined();
      expect(toSessionCreateBody(latest()).nodeId).toBe("a1");
      // No override warning: the picker already tells the truth.
      expect(screen.queryByText(/overrides Local/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("an explicit Local pick survives the anchor, goes omitted on the wire, and warns", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE], [pinnedProfile("a1")]);
    try {
      const { latest } = renderForm({
        profileId: "p1",
        workingDir: "/tmp/x",
        name: "",
        nodeId: "local",
        nodeExplicit: true, // a user pick since this profile change
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(latest().nodeId).toBe("local");
      expect(toSessionCreateBody(latest()).nodeId).toBeUndefined();
      expect(screen.getByText("This profile runs on mac mini — it overrides Local.")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("an offline pinned node stays selected — the 409 will match the display", async () => {
    const restore = mockFetch([LOCAL, AGENT_OFFLINE], [pinnedProfile("a2")]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await waitFor(() => expect(latest().nodeId).toBe("a2"));
      // Not re-homed to local by the vanish rule: the disabled-but-selected
      // chip IS the honest launch target.
      expect(screen.getByText("old laptop — offline")).toBeDefined();
      expect(screen.queryByText(/overrides Local/)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("optional session name input", () => {
  it("caps the draft at the backend's 120-char rule", () => {
    const restore = mockFetch([LOCAL]);
    try {
      renderForm();
      const input = screen.getByLabelText("Session name (optional)") as HTMLInputElement;
      expect(input.maxLength).toBe(120);
    } finally {
      restore();
    }
  });
});
