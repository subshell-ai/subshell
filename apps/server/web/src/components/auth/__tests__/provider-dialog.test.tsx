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
      await pickOption("Provider kind", "Generic OIDC");
      expect(issuerInput().value).toBe("");
      // …but a hand-entered issuer is the admin's answer, not ours to eat.
      fireEvent.change(issuerInput(), { target: { value: "https://hand-entered.example" } });
      await pickOption("Provider kind", "Google");
      expect(issuerInput().value).toBe("https://hand-entered.example");
      await pickOption("Provider kind", "Generic OIDC");
      expect(issuerInput().value).toBe("https://hand-entered.example");
    } finally {
      restore();
    }
  });

  it("create mode's Other escape stays reachable when the seed exhausts the candidates", async () => {
    const { restore } = mockFetch({}); // candidates: this browser's origin alone
    try {
      renderDialog();
      await settle();
      // The create seed IS the only candidate, so Other is all the Select has
      // left. It must be usable, not gated away with the button.
      const addButton = () => screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
      expect(addButton().disabled).toBe(true); // empty text
      fireEvent.change(screen.getByLabelText("Other address"), { target: { value: "https://off-registry.example" } });
      await settle();
      expect(addButton().disabled).toBe(false);
      fireEvent.click(addButton());
      await settle();
      expect(screen.getByRole("button", { name: "Remove https://off-registry.example" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("create pre-adds the app base URL as the canonical entry", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      renderDialog();
      await settle();
      // Spec §5a: position 1 on create is APP_BASE_URL's origin, badged.
      expect(screen.getByRole("button", { name: "Remove https://plane.example" })).toBeDefined();
      expect(screen.getByText("Canonical")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("falls back to this browser's origin only while appBaseUrl is unknown", async () => {
    const { restore } = mockFetch({}); // a server predating the field
    try {
      renderDialog();
      await settle();
      expect(screen.getByRole("button", { name: `Remove ${window.location.origin}` })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("the Other escape unlocks Add when every candidate is already an entry", async () => {
    const { restore } = mockFetch({ trustedOrigins: ["https://plane.example"], appBaseUrl: "https://plane.example" });
    try {
      // Edit mode with both candidates (this browser's, the base URL's) already
      // entries: the case `offered.length === 1` used to deadlock — Add
      // disabled exactly when Other exists.
      renderDialog({ provider: view({ entryOrigins: [window.location.origin, "https://plane.example"] }) });
      await settle();
      const addButton = () => screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
      const otherInput = () => screen.getByLabelText("Other address") as HTMLInputElement;
      // Empty text: nothing to add yet.
      expect(addButton().disabled).toBe(true);
      // Garbage: still disabled, the guard is validity, not presence.
      fireEvent.change(otherInput(), { target: { value: "not a url" } });
      await settle();
      expect(addButton().disabled).toBe(true);
      // A valid bare origin: Add lives, and the entry lands in the list.
      fireEvent.change(otherInput(), { target: { value: "https://still-learning.example" } });
      await settle();
      expect(addButton().disabled).toBe(false);
      fireEvent.click(addButton());
      await settle();
      expect(screen.getByRole("button", { name: "Remove https://still-learning.example" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("the panel renders before the door is named, and only the URIs wait", async () => {
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
      expect(panel.getByText("Appears once you name the door.")).toBeDefined();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work SSO" } });
      await settle();
      expect(panel.getByText("https://plane.example/api/auth/callback/work-sso")).toBeDefined();
      expect(panel.queryByText("Appears once you name the door.")).toBeNull();
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
