import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileInstallDialog } from "@/components/mobile-install-dialog";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141";

/** The navigator's own descriptor, restored after every test — bun runs every
 * file in one process, so a UA left overwritten here is the next suite's UA. */
let previousUserAgent: PropertyDescriptor | undefined;

function renderDialog(options: { origin: string; trustedOrigins?: string[]; userAgent?: string; admin?: boolean }) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", {
    value: options.userAgent ?? DESKTOP,
    configurable: true,
    writable: true,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["settings-public"], {
    allowRegistrations: false,
    emergencyLoginActive: false,
    instanceName: "Prod plane",
    appBaseUrl: "http://localhost:3080",
    trustedOrigins: options.trustedOrigins ?? ["http://localhost:3080"],
    viewerIsAdmin: options.admin ?? false,
    serverVersion: "0.2.0",
    nodeArtifactTargets: [],
    nodeArtifactsAutoFetch: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <MobileInstallDialog open onOpenChange={() => {}} origin={options.origin} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  previousUserAgent = undefined;
});

describe("MobileInstallDialog", () => {
  it("offers the reachable address rather than the loopback one this browser is on", () => {
    // The whole point of the picker: the laptop is on localhost, the phone
    // cannot be, and the tailnet name is the only answer that works.
    renderDialog({
      origin: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "https://plane.tail1234.ts.net"],
    });
    expect(screen.getByRole("img", { name: /https:\/\/plane\.tail1234\.ts\.net/ })).toBeTruthy();
    // Twice over, and both matter: the dropdown's closed state shows what is
    // selected, and the copy row hands the same string over.
    expect(screen.getAllByText("https://plane.tail1234.ts.net").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: /copy address/i })).toBeTruthy();
  });

  it("names the selected loopback address and offers no QR to scan", () => {
    renderDialog({ origin: "http://localhost:3080", trustedOrigins: ["http://127.0.0.1:3080"] });
    const note = screen.getByTestId("unreachable-note");
    // It names the address rather than describing the list: the person is
    // looking at one row and needs to know what THAT one does.
    expect(note.textContent).toMatch(/http:\/\/localhost:3080/);
    expect(note.textContent).toMatch(/reaches itself/i);
    // No other address exists here, so "pick one of the others" would be a lie.
    expect(note.textContent).toMatch(/knows no other/i);
    // A QR of `http://localhost:3080` is a thing someone WILL scan, and on the
    // phone it resolves to that phone's own port 3080.
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy address/i })).toBeNull();
  });

  it("keeps every row selectable — a loopback-only instance can still be operated", () => {
    // The defect this closes: loopback rows were `disabled`, and on a stock
    // instance EVERY address is loopback, so the picker refused every choice
    // and could not be operated at all. It still SAYS what the choice costs —
    // that moved from an inert row to a sentence under the field.
    renderDialog({
      origin: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "http://localhost:5174"],
    });
    fireEvent.click(document.querySelector('[data-slot="select-trigger"]') as HTMLElement);

    const rows = [...document.querySelectorAll('[data-slot="select-item"]')];
    const other = rows.find((r) => r.textContent?.includes("127.0.0.1:3080")) as HTMLElement;
    expect(other).toBeTruthy();
    // Listed WITH its consequence, and inert in neither direction.
    expect(other.textContent).toContain("this device only");
    expect(other.getAttribute("data-disabled")).toBeNull();

    // Every row, not just this one: the bug was blanket, so the guard is too.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.getAttribute("data-disabled") === null)).toBe(true);
  });

  it("warns that an http address costs notifications, and names the fix for an admin", () => {
    renderDialog({ origin: "http://192.168.1.14:3080", trustedOrigins: [], admin: true });
    const note = screen.getByTestId("insecure-note");
    expect(note.textContent).toMatch(/notifications/i);
    expect(note.textContent).toMatch(/Networking/);
  });

  it("does not point a non-admin at a page they cannot open", () => {
    renderDialog({ origin: "http://192.168.1.14:3080", trustedOrigins: [], admin: false });
    const note = screen.getByTestId("insecure-note");
    expect(note.textContent).toMatch(/notifications/i);
    expect(note.textContent).not.toMatch(/Networking/);
  });

  it("says nothing about secure contexts on an https address", () => {
    renderDialog({ origin: "https://plane.tail1234.ts.net", trustedOrigins: [] });
    expect(screen.queryByTestId("insecure-note")).toBeNull();
  });

  it("opens on the steps for the device reading it, and every tab stays reachable", () => {
    renderDialog({ origin: "https://plane.tail1234.ts.net", trustedOrigins: [], userAgent: IPHONE });
    expect(screen.getByRole("button", { name: "iPhone & iPad" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("list").textContent).toMatch(/Add to Home Screen/);

    fireEvent.click(screen.getByRole("button", { name: "Android" }));
    expect(screen.getByRole("list").textContent).toMatch(/Install app/);
  });

  it("opens on the desktop steps in a desktop browser", () => {
    renderDialog({ origin: "https://plane.tail1234.ts.net", trustedOrigins: [], userAgent: DESKTOP });
    expect(screen.getByRole("button", { name: "Browser" }).getAttribute("aria-pressed")).toBe("true");
  });
});
