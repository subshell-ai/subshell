import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProviderDialog } from "@/components/auth/provider-dialog";
import {
  callbackUrlFor,
  GOOGLE_ISSUER,
  type ProviderAdminView,
  previewProviderId,
  registrationDisplay,
} from "@/types/auth-provider";

/**
 * Pure-helper tests + a dialog smoke, the shape `switch-preset-dialog.test.tsx`
 * established: mock `fetch` per file (the preload delegator still lets
 * import-time binders through), render inside a QueryClientProvider, and drive
 * Base UI selects with the pointer triple a bare `fireEvent.click` cannot
 * replace.
 */

function view(overrides: Partial<ProviderAdminView> = {}): ProviderAdminView {
  return {
    id: "google",
    kind: "google",
    name: "Google",
    issuer: GOOGLE_ISSUER,
    clientId: "cid",
    hasSecret: true,
    entryOrigins: ["https://plane.example", "http://localhost:3080"],
    allowedDomains: [],
    enabled: true,
    signInEnabled: true,
    registrationEnabled: false,
    requireApproval: false,
    endpointsResolved: true,
    ...overrides,
  };
}

describe("callbackUrlFor", () => {
  it("joins the stored origin, the fixed path and the id byte-exactly", () => {
    expect(callbackUrlFor("https://plane.example", "google")).toBe("https://plane.example/api/auth/callback/google");
  });
  it("keeps a loopback origin's port", () => {
    expect(callbackUrlFor("http://localhost:3080", "door-2")).toBe("http://localhost:3080/api/auth/callback/door-2");
  });
  it("adds nothing but the path (the entry is stored bare)", () => {
    expect(callbackUrlFor("https://mesh.netbird.example", "x")).toBe(
      "https://mesh.netbird.example/api/auth/callback/x",
    );
  });
});

describe("registrationDisplay", () => {
  it("renders the email row's null as the computed gate, in its own words", () => {
    const open = registrationDisplay(view({ id: "email", kind: "email", registrationEnabled: null }), true);
    expect(open.checked).toBe(true);
    expect(open.computed).toBe(true);
    expect(open.label).toBe("Open until someone registers");
    const closed = registrationDisplay(view({ id: "email", kind: "email", registrationEnabled: null }), false);
    expect(closed.checked).toBe(false);
    expect(closed.computed).toBe(true);
  });
  it("renders an explicit flag as itself", () => {
    expect(registrationDisplay(view({ registrationEnabled: true }), false)).toEqual({
      checked: true,
      label: "Open",
      computed: false,
    });
    expect(registrationDisplay(view({ registrationEnabled: false }), true)).toEqual({
      checked: false,
      label: "Closed",
      computed: false,
    });
  });
});

describe("previewProviderId", () => {
  it("slugs a normal name the way the server does", () => {
    expect(previewProviderId("Google Work")).toBe("google-work");
  });
  it("collapses runs and trims edge punctuation", () => {
    expect(previewProviderId("  Acme !! Corp  ")).toBe("acme-corp");
  });
  it("caps at 40 characters", () => {
    expect(previewProviderId("a".repeat(60))).toBe("a".repeat(40));
  });
});

// === dialog smoke ===

function mockFetch(publicSettings?: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify(publicSettings ?? {}), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

function renderDialog(props: Partial<Parameters<typeof ProviderDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      {/* `provider: null` is the create mode; the type requires the prop, and
          an omitted one is NOT null to the dialog's `editing` test. */}
      <ProviderDialog open onOpenChange={() => {}} onSaved={() => {}} provider={null} {...props} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ProviderDialog", () => {
  it("the Google preset prefills the issuer", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      renderDialog();
      await settle();
      const kindSelect = screen.getByRole("combobox", { name: "Provider kind" });
      fireEvent.click(kindSelect);
      await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
      const option = screen.getByRole("option", { name: "Google" });
      fireEvent.pointerDown(option);
      fireEvent.pointerUp(option);
      fireEvent.click(option);
      await settle();
      expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("");
      expect((screen.getByLabelText("Issuer") as HTMLInputElement).value).toBe(GOOGLE_ISSUER);
    } finally {
      restore();
    }
  });

  it("the copy panel lists the redirect URI and JS origin for every entry", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      renderDialog({ provider: view() });
      await settle();
      // Scoped to the panel: the addresses also sit in the entry-point editor
      // rows above, and the test is about the copy fields.
      const panel = within(screen.getByRole("group", { name: "Finish the setup at your provider" }));
      expect(panel.getByText("https://plane.example/api/auth/callback/google")).toBeDefined();
      expect(panel.getByText("http://localhost:3080/api/auth/callback/google")).toBeDefined();
      expect(panel.getByText("https://plane.example")).toBeDefined();
      expect(panel.getByText("http://localhost:3080")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("the secret field keeps the stored secret out of the form", async () => {
    const { restore } = mockFetch();
    try {
      renderDialog({ provider: view() });
      await settle();
      expect((screen.getByLabelText("Client secret") as HTMLInputElement).placeholder).toBe("leave blank to keep");
      expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    } finally {
      restore();
    }
  });

  it("create mode has no keep-placeholder: the secret is required", async () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      await settle();
      expect((screen.getByLabelText("Client secret") as HTMLInputElement).placeholder).not.toBe("leave blank to keep");
    } finally {
      restore();
    }
  });

  it("edit mode fixes the kind", async () => {
    const { restore } = mockFetch();
    try {
      renderDialog({ provider: view() });
      await settle();
      expect((screen.getByRole("combobox", { name: "Provider kind" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      restore();
    }
  });
});
