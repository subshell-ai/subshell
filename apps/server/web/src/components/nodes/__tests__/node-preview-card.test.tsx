import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NodePreviewCard } from "@/components/nodes/node-preview-card";

/**
 * The Preview card on the node page (task-12 Step 4, pinned by Step 1): the
 * same gate and tooltip posture as the SSH card beside it - owner-only flip,
 * honest remedy line for a non-owner, and a single PUT of `{on}` at the Task
 * 3 route. The fetch mock is the route, and the node arrives as a prop.
 */

type Call = { method: string; url: string; body?: Record<string, unknown> };

function node(over: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.0.0",
    protocolVersion: 12,
    access: "owner",
    canManage: true,
    canRetire: true,
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
    sshWideForwards: false,
    webPreviewsEnabled: false,
    held: null,
    ...over,
  } as NodeDetail;
}

function mount(
  n: NodeDetail,
  readiness: { body: unknown; status?: number } = { body: { supported: true, missing: [] } },
) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
    });
    if (url.pathname.endsWith("/display-readiness")) {
      return Promise.resolve(new Response(JSON.stringify(readiness.body), { status: readiness.status ?? 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ...n, webPreviewsEnabled: true })));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <NodePreviewCard node={n} />
    </QueryClientProvider>,
  );
  return {
    view,
    calls,
    restore: () => (globalThis.fetch = original),
  };
}

afterEach(() => cleanup());

describe("the Preview switch", () => {
  it("reflects the stored flag and asks the route when flipped", async () => {
    const h = mount(node({ webPreviewsEnabled: false }));
    try {
      const toggle = screen.getByRole("switch", { name: /allow web previews/i });
      // Cast-and-read, this repo's convention (Base UI wears aria-checked and
      // aria-disabled; there is no jest-dom dependency here).
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(toggle.matches(":disabled, [aria-disabled=true]")).toBe(false);
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(h.calls.find((c) => c.method === "PUT" && c.url === "/api/nodes/node1/views-enabled")).toBeTruthy(),
      );
      expect(h.calls.find((c) => c.method === "PUT" && c.url === "/api/nodes/node1/views-enabled")?.body).toEqual({
        on: true,
        feature: "web-previews",
      });
    } finally {
      h.restore();
    }
  });

  it("a checked switch mirrors the stored on-state", () => {
    const h = mount(node({ webPreviewsEnabled: true }));
    try {
      expect(screen.getByRole("switch", { name: /allow web previews/i }).getAttribute("aria-checked")).toBe("true");
    } finally {
      h.restore();
    }
  });

  it("a non-owner sees it disabled with the owner remedy", () => {
    const h = mount(node({ canManage: false, access: "edit" }));
    try {
      expect(
        screen.getByRole("switch", { name: /allow web previews/i }).matches(":disabled, [aria-disabled=true]"),
      ).toBe(true);
      expect(screen.getAllByText(/only this node/i)[0]).toBeTruthy();
    } finally {
      h.restore();
    }
  });

  it("the local host answers with the admin remedy line", () => {
    const h = mount(node({ kind: "local", canManage: false }));
    try {
      expect(screen.getAllByText(/an admin can change this setting/i)[0]).toBeTruthy();
    } finally {
      h.restore();
    }
  });
});

describe("node view prerequisites", () => {
  it("explains disabled features without probing the node", () => {
    const h = mount(node());
    try {
      expect(screen.getByText("Web previews are disabled on this node.")).toBeTruthy();
      expect(h.calls).toHaveLength(0);
    } finally {
      h.restore();
    }
  });

  it("shows missing requirements and clears the warning after a successful recheck", async () => {
    const readiness = { body: { supported: true, missing: ["xauth"] } };
    const h = mount(node({ webPreviewsEnabled: true, virtualDisplayEnabled: true }), readiness);
    try {
      const guide = await within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).findByRole(
        "link",
        { name: "Set up virtual display" },
      );
      expect(guide.getAttribute("href")).toBe("https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux");
      expect(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).getByText(
          "Virtual display requirements are missing on the selected node.",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("switch", { name: /allow virtual displays/i }).getAttribute("aria-checked")).toBe("true");
      readiness.body = { supported: true, missing: [] };
      fireEvent.click(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).getByRole("button", {
          name: "Recheck",
        }),
      );
      await within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).findByText(
        "Virtual display requirements are met.",
      );
      expect(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).queryByRole("link", {
          name: "Set up virtual display",
        }),
      ).toBeNull();
      expect(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).queryByRole("button", {
          name: "Recheck",
        }),
      ).toBeNull();
    } finally {
      h.restore();
    }
  });

  it("explains unsupported features while keeping saved services available", async () => {
    const h = mount(node({ webPreviewsEnabled: true, virtualDisplayEnabled: true, os: "darwin" }), {
      body: { supported: false, missing: [] },
    });
    try {
      expect(screen.queryByRole("group", { name: "Xvfb + VNC display provider" })).toBeNull();
      expect(screen.getByText(/Automatic app discovery and browser watching require Linux/)).toBeTruthy();
      expect(
        await within(screen.getByRole("group", { name: "BetterDisplay display provider" })).findByText(
          "This virtual display provider does not support the selected node.",
        ),
      ).toBeTruthy();
    } finally {
      h.restore();
    }
  });

  it("shows a failed check and lets a read-only viewer retry it", async () => {
    const readiness = { body: { message: "Bring this node online, then recheck." } as unknown, status: 409 };
    const h = mount(
      node({ webPreviewsEnabled: true, virtualDisplayEnabled: true, canManage: false, access: "view" }),
      readiness,
    );
    try {
      await within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).findByText(
        /Bring this node online, then recheck/,
      );
      expect(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).queryByText(
          "Virtual display requirements are met.",
        ),
      ).toBeNull();
      readiness.body = { supported: true, missing: [] };
      readiness.status = 200;
      fireEvent.click(
        within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).getByRole("button", {
          name: "Recheck",
        }),
      );
      await within(screen.getByRole("group", { name: "Xvfb + VNC display provider" })).findByText(
        "Virtual display requirements are met.",
      );
      expect(
        screen.getByRole("switch", { name: /allow virtual displays/i }).matches(":disabled, [aria-disabled=true]"),
      ).toBe(true);
    } finally {
      h.restore();
    }
  });
});

it("apps need no display prerequisites and display has its own switch", async () => {
  const h = mount(node({ webPreviewsEnabled: true, virtualDisplayEnabled: false }));
  try {
    expect(screen.getByRole("switch", { name: "Allow web previews" }).getAttribute("aria-checked")).toBe("true");
    const display = screen.getByRole("switch", { name: "Allow virtual displays" });
    expect(display.getAttribute("aria-checked")).toBe("false");
    expect(h.calls).toHaveLength(0);
    fireEvent.click(display);
    await waitFor(() => expect(h.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(h.calls.find((c) => c.method === "PUT")?.body).toEqual({ on: true, feature: "display" });
  } finally {
    h.restore();
  }
});

it("shows the provider selector when virtual displays are enabled", async () => {
  const h = mount(node({ virtualDisplayEnabled: true, virtualDisplayProvider: "xvfb-x11vnc" }));
  try {
    expect(screen.queryByRole("group", { name: "BetterDisplay display provider" })).toBeNull();
    expect(screen.queryByText(/On this node's Mac/)).toBeNull();
    const picker = screen.getByRole("combobox", { name: "Default display provider" });
    expect(picker.textContent).toContain("Xvfb + VNC");
    fireEvent.click(picker);
    expect(await screen.findByRole("option", { name: "Xvfb + VNC" })).toBeTruthy();
    expect(screen.getByText(/Existing subshells keep their saved provider/)).toBeTruthy();
  } finally {
    h.restore();
  }
});

it("enabling BetterDisplay chooses a supported default on a Mac with legacy Linux settings", async () => {
  const h = mount(
    node({
      os: "darwin",
      virtualDisplayEnabled: true,
      virtualDisplayProviders: ["xvfb-x11vnc"],
      virtualDisplayProvider: "xvfb-x11vnc",
    }),
  );
  try {
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow BetterDisplay" }));
    await waitFor(() => expect(h.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(h.calls.find((c) => c.method === "PUT")?.body).toEqual({
      on: true,
      feature: "display",
      providers: ["xvfb-x11vnc", "betterdisplay"],
      provider: "betterdisplay",
    });
    expect(screen.getByRole("link", { name: "Setup instructions" }).getAttribute("href")).toContain(
      "#macos-display-helper",
    );
  } finally {
    h.restore();
  }
});

it("explains when no bundled provider supports the node", () => {
  const h = mount(node({ os: "win32", virtualDisplayEnabled: true }));
  try {
    expect(screen.getByText("No bundled virtual display provider supports this node's operating system.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Allow BetterDisplay" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Allow Xvfb + VNC" })).toBeNull();
    expect(h.calls).toHaveLength(0);
  } finally {
    h.restore();
  }
});
