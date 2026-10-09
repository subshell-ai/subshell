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
    expect(callbackUrlFor("http://localhost:3080", "provider-2")).toBe(
      "http://localhost:3080/api/auth/callback/provider-2",
    );
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
    // The CLOSED direction is the one that shipped broken: a null flag beside
    // an already-closed gate must not say "Open until someone registers" —
    // the label follows the computed decision, not just the switch.
    const closed = registrationDisplay(view({ id: "email", kind: "email", registrationEnabled: null }), false);
    expect(closed.checked).toBe(false);
    expect(closed.computed).toBe(true);
    expect(closed.label).toBe("Automatically closed once the first account signed up");
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
  it("is idempotent at the cap — never strands a trailing dash the server would refuse", () => {
    // The 41st character was a dash under the old slice-last order, so the
    // preview came back "a"*39 + "-" and the server's strict-id gate refused
    // the dialog's own prediction. Trim runs after the cap now, in BOTH
    // mirrors (this file and the server's slugifyProviderId).
    expect(previewProviderId(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
    for (const x of [`${"a".repeat(39)}-b`, "x".repeat(45), "---y---", "a-".repeat(25)]) {
      expect(previewProviderId(previewProviderId(x))).toBe(previewProviderId(x));
    }
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

async function pickOption(triggerName: string, optionName: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
  const option = screen.getByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
  await settle();
}

describe("ProviderDialog", () => {
  it("the Google preset is true AT REST, and switching away clears only the preset", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      renderDialog();
      await settle();
      // At rest: no dropdown interaction. A fresh create dialog shows Google
      // chosen AND its issuer filled, so Save is not held hostage to a click.
      const issuerInput = () => screen.getByLabelText("Issuer") as HTMLInputElement;
      expect(issuerInput().value).toBe(GOOGLE_ISSUER);
      expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("");
      // Switching away retracts the preset the dialog itself wrote…
      await pickOption("Provider", "Generic OIDC");
      expect(issuerInput().value).toBe("");
      // …but a hand-entered issuer is the admin's answer, not ours to eat.
      fireEvent.change(issuerInput(), { target: { value: "https://hand-entered.example" } });
      await pickOption("Provider", "Google");
      expect(issuerInput().value).toBe("https://hand-entered.example");
      await pickOption("Provider", "Generic OIDC");
      expect(issuerInput().value).toBe("https://hand-entered.example");
    } finally {
      restore();
    }
  });

  it("uses the public base URL even when the stored legacy list starts with a LAN address", async () => {
    const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
    try {
      renderDialog({ provider: view({ entryOrigins: ["http://10.1.10.50:3080", "https://plane.example"] }) });
      await settle();
      expect(screen.getByText("https://plane.example/api/auth/callback/google")).toBeTruthy();
      expect(screen.queryByText("http://10.1.10.50:3080/api/auth/callback/google")).toBeNull();
      expect((screen.getByLabelText("Callback base URL override (optional)") as HTMLInputElement).value).toBe("");
    } finally {
      restore();
    }
  });

  it("previews an explicit override and returns to the public URL when cleared", async () => {
    const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
    try {
      renderDialog({ provider: view({ callbackBaseUrl: "https://override.example" }) });
      await settle();
      expect(screen.getByText("https://override.example/api/auth/callback/google")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Callback base URL override (optional)"), { target: { value: "" } });
      expect(screen.getByText("https://plane.example/api/auth/callback/google")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("explains invalid overrides and refuses saving", async () => {
    const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
    try {
      renderDialog({ provider: view() });
      await settle();
      fireEvent.change(screen.getByLabelText("Callback base URL override (optional)"), {
        target: { value: "https://override.example/path" },
      });
      expect(screen.getByRole("alert").textContent).toContain("no path");
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it("the panel renders before the provider is named, and only the URIs wait", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      // Operator ask 2026-09-25: a FRESH dialog showed no panel at all (the
      // old early-return on an empty id), which read as the provider-side
      // instructions being missing. The instructions and the JS origins are
      // knowable from the first paint; only the URI rows need the slug.
      renderDialog();
      await settle();
      const panel = within(screen.getByRole("group", { name: "Finish the setup at your provider" }));
      expect(panel.getByText(/Create one web-application OIDC client/)).toBeDefined();
      expect(panel.getByText("https://plane.example")).toBeDefined();
      expect(panel.getByText("Appears once you name the provider.")).toBeDefined();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work SSO" } });
      await settle();
      expect(panel.getByText("https://plane.example/api/auth/callback/work-sso")).toBeDefined();
      expect(panel.queryByText("Appears once you name the provider.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("the copy panel lists only the effective callback base and full redirect URI", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      renderDialog({ provider: view() });
      await settle();
      // Scoped to the panel: the addresses also sit in the entry-point editor
      // rows above, and the test is about the copy fields.
      const panel = within(screen.getByRole("group", { name: "Finish the setup at your provider" }));
      expect(panel.getByText("https://plane.example/api/auth/callback/google")).toBeDefined();
      expect(panel.queryByText("http://localhost:3080/api/auth/callback/google")).toBeNull();
      expect(panel.getByText("https://plane.example")).toBeDefined();
      expect(panel.queryByText("http://localhost:3080")).toBeNull();
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
      expect((screen.getByRole("combobox", { name: "Provider" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it("clicking out or pressing Escape keeps the form; a half-typed issuer survives", async () => {
    // The loss this pins: an outside press discarded the whole dialog with a
    // half-entered issuer in it (the 2026-09-30 form-dialog ruling, now read
    // by this dialog through the shared guard).
    const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
    try {
      const closed: boolean[] = [];
      renderDialog({ onOpenChange: (next) => closed.push(next) });
      await settle();
      const issuerInput = () => screen.getByLabelText("Issuer") as HTMLInputElement;
      fireEvent.change(issuerInput(), { target: { value: "https://half-typed" } });
      const backdrop = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
      fireEvent.mouseDown(backdrop);
      fireEvent.mouseUp(backdrop);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await settle();
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(closed).toEqual([]);
      expect(issuerInput().value).toBe("https://half-typed");
      // The X still closes: reason "close-press" passes the guard untouched.
      fireEvent.click(screen.getByLabelText("Close"));
      await settle();
      expect(closed).toEqual([false]);
    } finally {
      restore();
    }
  });
});
