import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * The wizard's refusal and empty-state branches (wave-2 review M2): machines
 * the caller does not OWN never appear; ineligible machines are shown disabled
 * with the reason; a failed config read is never the empty-list copy; and a
 * named resolve refusal renders the SHIPPED sentence from
 * `SSH_ERROR_DESCRIPTIONS` plus the blocked settings, never the wire code.
 */

const BASE: Node = {
  id: "n1",
  name: "Laptop",
  kind: "agent",
  os: "linux",
  arch: "x86_64",
  hostname: "laptop-01",
  status: "online",
  lastSeenAt: new Date().toISOString(),
  agentVersion: null,
  protocolVersion: null,
  access: "owner",
  canManage: true,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
};

interface JourneyFetchOptions {
  nodes?: Node[];
  brokers?: { id: string; name: string; online: boolean }[];
  admin?: boolean;
  serverEnabled?: boolean;
  aliases?: string[];
  /** Set to make discovery answer non-OK (the failure-vs-empty branch). */
  discoveryStatus?: number;
  resolveBody?: unknown;
  brokersStatus?: number;
  brokerRead?: Promise<void>;
}

function mockFetch(over: JourneyFetchOptions = {}) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/settings/public")
      return json({ viewerIsAdmin: over.admin ?? false, allowServerSubshells: over.serverEnabled ?? true });
    if (url.pathname === "/api/ssh-runtime/desktop-brokers") {
      await over.brokerRead;
      return over.brokersStatus
        ? json({ message: "Computer connections unavailable" }, over.brokersStatus)
        : json({ brokers: over.brokers ?? [] });
    }
    if (url.pathname === "/api/nodes") return json({ nodes: over.nodes ?? [] });
    if (url.pathname === "/api/presets") return json([]);
    if (url.pathname === "/api/ssh-runtime/discovery") {
      if (over.discoveryStatus !== undefined && over.discoveryStatus !== 200) {
        return json({ message: "The node refused the read." }, over.discoveryStatus);
      }
      return json({ aliases: over.aliases ?? [], includeCycle: false, truncated: false });
    }
    if (url.pathname === "/api/ssh-runtime/resolve")
      return json(over.resolveBody ?? { accepted: false, code: "config_missing", settings: [] });
    return json({});
  }) as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Flush pending query/effect updates inside act() (the repo-wide settle pattern). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** The journey is mounted as the index route of a throwaway router (it calls useNavigate). */
async function renderJourney(prefill: { nodeId: string; alias: string } | null = null): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ConnectJourney prefill={prefill} onConnected={() => {}} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
}

afterEach(cleanup);

/** Open the machine picker (a `SearchableSelect`) the way the mouse does. */
async function openMachinePopup(): Promise<HTMLInputElement> {
  const input = screen.getByPlaceholderText("Choose a computer") as HTMLInputElement;
  fireEvent.mouseDown(input);
  fireEvent.click(input);
  await screen.findAllByRole("option");
  return input;
}

/** Choose a connecting machine from the picker, then let the host step settle. */
async function pickMachineByName(name: RegExp | string): Promise<void> {
  const input = await openMachinePopup();
  void input;
  fireEvent.click(await screen.findByRole("option", { name }));
  await settle();
}

describe("ConnectJourney machine step", () => {
  it("an empty owned-machine list names the need and the remedy, not a broken list", async () => {
    const m = mockFetch({ nodes: [{ ...BASE, id: "other", access: "edit" }] });
    try {
      await renderJourney();
      expect(screen.getByText(/You haven’t connected a computer for SSH yet/)).toBeTruthy();
      expect(screen.getByRole("link", { name: /open Settings/ }).getAttribute("href")).toBe("/settings/connections");
      // Nothing to pick, so the picker itself is absent; the shared machine is
      // never offered because broker rights are ownership, not access.
      expect(screen.queryByPlaceholderText("Choose a computer")).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("ineligible machines are shown DISABLED with the reason, never hidden", async () => {
    const m = mockFetch({
      nodes: [
        BASE,
        { ...BASE, id: "n2", name: "Docking", status: "offline" },
        { ...BASE, id: "n3", name: "Workshop", maintenance: true },
      ],
    });
    try {
      await renderJourney();
      await openMachinePopup();
      // A disabled row is still listed and explains itself; greying explains,
      // never hides. Enabled rows carry no data-disabled marker.
      expect(screen.getByRole("option", { name: /Laptop/ }).getAttribute("data-disabled")).toBeNull();
      const offline = screen.getByRole("option", { name: /Docking/ });
      expect(offline.getAttribute("data-disabled")).toBe("");
      expect(offline.textContent).toContain("offline");
      const maint = screen.getByRole("option", { name: /Workshop/ });
      expect(maint.getAttribute("data-disabled")).toBe("");
      expect(maint.textContent).toContain("in maintenance");
    } finally {
      m.restore();
    }
  });

  it("a hostname a row shows is searchable even though the detail line is `reason`", async () => {
    const m = mockFetch({ nodes: [BASE, { ...BASE, id: "n2", name: "Docking", hostname: "dock-77" }] });
    try {
      await renderJourney();
      const input = await openMachinePopup();
      fireEvent.change(input, { target: { value: "dock-77" } });
      await waitFor(() => expect(screen.queryByRole("option", { name: /Laptop/ })).toBeNull());
      expect(screen.getByRole("option", { name: /Docking/ })).toBeTruthy();
    } finally {
      m.restore();
    }
  });
});

describe("ConnectJourney host step", () => {
  it("an empty alias list says so; a failed read is never that sentence", async () => {
    const m = mockFetch({ nodes: [BASE], aliases: [] });
    try {
      await renderJourney({ nodeId: "n1", alias: "staging" });
      expect(await screen.findByText(/No SSH hosts found/)).toBeTruthy();
      expect(screen.queryByText(/could not be read/)).toBeNull();
      expect(screen.getByText(/HostName host.example.com/)).toBeTruthy();
      const readsBefore = m.seen.filter((url) => url.includes("/discovery")).length;
      fireEvent.click(screen.getByRole("button", { name: "Refresh hosts" }));
      await settle();
      expect(m.seen.filter((url) => url.includes("/discovery")).length).toBeGreaterThan(readsBefore);
    } finally {
      m.restore();
    }
  });

  it("a failed config read is the failure row, never the empty-list sentence", async () => {
    const m = mockFetch({ nodes: [BASE], discoveryStatus: 502 });
    try {
      await renderJourney({ nodeId: "n1", alias: "staging" });
      // The read's own error (the failure alert carries it verbatim) plus a
      // Retry; the empty copy must stay silent, that is the whole distinction.
      expect(await screen.findByText(/The node refused the read\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText(/No SSH hosts found/)).toBeNull();
    } finally {
      m.restore();
    }
  });
});

describe("ConnectJourney review step", () => {
  it("renders the shipped sentence for a named refusal, the blocked settings, and never the wire code", async () => {
    const m = mockFetch({
      nodes: [BASE],
      aliases: ["staging"],
      resolveBody: {
        accepted: false,
        code: "unsupported_setting",
        settings: ["ProxyCommand", "LocalForward"],
      },
    });
    try {
      await renderJourney();
      await pickMachineByName(/Laptop/);
      const alias = await screen.findByRole("button", { name: "staging" });
      fireEvent.click(alias);
      // The equality mapping, mirrored from the old editor: the package's own
      // sentence, rendered verbatim.
      expect(await screen.findByText(SSH_ERROR_DESCRIPTIONS.unsupported_setting)).toBeTruthy();
      expect(screen.getByText(/Unsupported SSH settings: ProxyCommand, LocalForward/)).toBeTruthy();
      // The raw wire code is not human copy (finding I1): nothing renders it.
      expect(screen.queryByText(/unsupported_setting/)).toBeNull();
      // The refusal leaves Connect inert: the review has nothing to open.
      expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("an accepted resolve shows the destination and the connecting account", async () => {
    const m = mockFetch({
      nodes: [BASE],
      aliases: ["staging"],
      resolveBody: {
        accepted: true,
        snapshot: { alias: "staging", host: "app-02", user: "deploy", port: 22, identityFiles: [] },
        connectingAccount: "theo",
      },
    });
    try {
      await renderJourney();
      await pickMachineByName(/Laptop/);
      fireEvent.click(await screen.findByRole("button", { name: "staging" }));
      expect(await screen.findByText("deploy@app-02:22")).toBeTruthy();
      expect(screen.getByText(/Laptop as theo/)).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Download the Subshell CLI" })).toBeNull();
      expect(screen.getByText(/Connect to this host, then choose a folder/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false);
    } finally {
      m.restore();
    }
  });
});

describe("server connection origin", () => {
  it("offers the server account only to admins and explains a disabled server", async () => {
    const m = mockFetch({
      admin: true,
      serverEnabled: false,
      nodes: [{ ...BASE, id: "local", kind: "local", name: "Server" }],
    });
    try {
      await renderJourney();
      await openMachinePopup();
      const server = screen.getByRole("option", { name: /Server/ });
      expect(server.getAttribute("data-disabled")).toBe("");
      expect(server.textContent).toContain("server launching disabled");
    } finally {
      m.restore();
    }
  });
  it("never offers server SSH credentials to a member", async () => {
    const m = mockFetch({ nodes: [{ ...BASE, id: "local", kind: "local", name: "Server" }] });
    try {
      await renderJourney();
      expect(screen.queryByPlaceholderText("Choose a computer")).toBeNull();
      expect(screen.queryByRole("option", { name: /Server/ })).toBeNull();
    } finally {
      m.restore();
    }
  });
});

describe("connecting computer discovery", () => {
  it("waits for computer connections before declaring no machines", async () => {
    let release = () => {};
    const m = mockFetch({
      brokerRead: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    try {
      await renderJourney();
      expect(screen.queryByText(/You haven’t connected a computer for SSH yet/)).toBeNull();
      release();
      await settle();
      expect(screen.getByText(/You haven’t connected a computer for SSH yet/)).toBeTruthy();
    } finally {
      release();
      m.restore();
    }
  });
  it("reports computer discovery failures with retry instead of an empty verdict", async () => {
    const m = mockFetch({ brokersStatus: 503 });
    try {
      await renderJourney();
      expect(screen.queryByText(/You haven’t connected a computer for SSH yet/)).toBeNull();
      expect(screen.getByRole("alert")).toBeTruthy();
      const before = m.seen.filter((url) => url.includes("desktop-brokers")).length;
      fireEvent.click(screen.getByRole("button", { name: "Retry computer connections" }));
      await settle();
      expect(m.seen.filter((url) => url.includes("desktop-brokers")).length).toBeGreaterThan(before);
    } finally {
      m.restore();
    }
  });
});

describe("this computer SSH identity", () => {
  const originalUA = navigator.userAgent;
  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUA });
    Reflect.deleteProperty(window, "__TAURI__");
    resetDesktopShellForTests();
  });
  function desktop(ids: string[]) {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "SubshellClient/1.0.0 (linux; p=1)" });
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: async (command: string) => {
            expect(command).toBe("desktop_ssh_identity");
            return ids;
          },
        },
      },
    });
    resetDesktopShellForTests();
  }
  it("identifies this computer by pairing ID rather than a matching name", async () => {
    desktop(["mine"]);
    const f = mockFetch({
      brokers: [
        { id: "other", name: "Laptop", online: true },
        { id: "mine", name: "Laptop", online: true },
      ],
    });
    try {
      await renderJourney();
      await pickMachineByName(/This computer/);
      expect(screen.getByText("Work on")).toBeTruthy();
    } finally {
      f.restore();
    }
  });
  it("offers pairing when the desktop identity is not visible to this account", async () => {
    desktop(["another-account"]);
    const f = mockFetch({ brokers: [{ id: "other", name: "Laptop", online: true }] });
    try {
      await renderJourney();
      fireEvent.click(await screen.findByRole("button", { name: "This computer · set up SSH" }));
      expect(await screen.findByText(/Your node registration stays unchanged/)).toBeTruthy();
    } finally {
      f.restore();
    }
  });
  it("does not offer this computer in a browser", async () => {
    const f = mockFetch();
    try {
      await renderJourney();
      expect(screen.queryByRole("button", { name: /This computer/ })).toBeNull();
    } finally {
      f.restore();
    }
  });
});
