import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileInstallDialog } from "@/components/mobile-install-dialog";
import { setFetchRouter } from "@/test-setup";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141";

/** The navigator's own descriptor, restored after every test — bun runs every
 * file in one process, so a UA left overwritten here is the next suite's UA. */
let previousUserAgent: PropertyDescriptor | undefined;

const restore: (() => void)[] = [];

function renderDialog(options: {
  origin: string;
  /** What the query cache already holds when the dialog opens */
  trustedOrigins?: string[];
  /** What the server answers the on-open refetch with; defaults to the cached list */
  serverTrustedOrigins?: string[];
  userAgent?: string;
  admin?: boolean;
}) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", {
    value: options.userAgent ?? DESKTOP,
    configurable: true,
    writable: true,
  });
  const payload = (trustedOrigins: string[]) => ({
    allowRegistrations: false,
    emergencyLoginActive: false,
    instanceName: "Prod plane",
    appBaseUrl: "http://localhost:3080",
    trustedOrigins,
    viewerIsAdmin: options.admin ?? false,
    serverVersion: "0.2.0",
    nodeArtifactTargets: [],
    nodeArtifactsAutoFetch: true,
  });
  const cached = options.trustedOrigins ?? ["http://localhost:3080"];
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname);
    return Promise.resolve(
      new Response(JSON.stringify(payload(options.serverTrustedOrigins ?? cached)), { status: 200 }),
    );
  }) as typeof fetch;
  setFetchRouter(globalThis.fetch as typeof fetch);
  restore.push(() => {
    globalThis.fetch = original;
    setFetchRouter(null);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["settings-public"], payload(cached));
  const view = render(
    <QueryClientProvider client={client}>
      <MobileInstallDialog open onOpenChange={() => {}} origin={options.origin} />
    </QueryClientProvider>,
  );
  return { ...view, calls };
}

afterEach(async () => {
  // The dialog refetches public settings on open and the assertions read the
  // CACHED payload while that promise is still in flight; react-query's
  // notify lands on a scheduled tick, and unmounting with it pending lets it
  // fire outside an acting scope. Draining a few turns INSIDE act() before
  // cleanup is the settle. (The positioner's own update is settled at its
  // source — where the Select is opened.)
  await act(async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  cleanup();
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  previousUserAgent = undefined;
  for (const undo of restore.splice(0)) undo();
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

  it("offers the derived LAN addresses and no loopback row at all", async () => {
    // The whole point of the server-side derivation: the laptop is on
    // localhost, the phone is not, and the picker now reads the machine's own
    // LAN address off the allowlist rather than confessing it knows none.
    renderDialog({
      origin: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "http://192.168.1.14:3080"],
    });
    expect(screen.getByRole("img", { name: /http:\/\/192\.168\.1\.14:3080/ })).toBeTruthy();

    // async act, not the sync fireEvent: opening the Select arms Radix's
    // positioner, whose floating update lands a microtask AFTER the sync
    // dispatch returns. Awaiting inside act() is what lets it render there
    // rather than emitting "not wrapped in act" into the suite's output.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-slot="select-trigger"]') as HTMLElement);
    });
    const rows = [...document.querySelectorAll('[data-slot="select-item"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("http://192.168.1.14:3080");
    // No "this device only" rows survive into a picker whose every row is
    // meant to be dialable by a phone.
    expect(document.body.textContent).not.toMatch(/this device only/);
  });

  it("says there is no phone-dialable address when the instance knows none", () => {
    // A loopback bind, or a server older than the LAN derivation. The refusal
    // renders WHERE THE QR WOULD BE — "where's the QR?" is the question an
    // absent code actually raises — and names the remedy, not just the lack.
    renderDialog({ origin: "http://localhost:3080", trustedOrigins: ["http://127.0.0.1:3080"] });
    const note = screen.getByTestId("no-address-note");
    expect(note.textContent).toMatch(/phone can open/i);
    // Joining a network IS a fix now — no publish step stands between them.
    expect(note.textContent).toMatch(/join a network/i);
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy address/i })).toBeNull();
  });

  it("explains neither where the addresses come from nor what http costs — the audience is developers", () => {
    // The picker used to carry a paragraph on how the allowlist is assembled
    // and an amber note on secure contexts. Both went 2026-09-18: the people
    // this dialog serves know what http:// means, and every clause of the
    // two blurbs restated the address bar itself. They stay gone on purpose;
    // this its the absence so a future "helpful" re-add trips here.
    renderDialog({ origin: "http://192.168.1.14:3080", trustedOrigins: [], admin: true });
    expect(screen.queryByTestId("insecure-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Every address this server accepts/);
    expect(document.body.textContent).not.toMatch(/plain http/i);
    expect(document.body.textContent).not.toMatch(/notifications never arrive/i);
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

  it("refetches the address list on open, so a network joined moments ago is already in the picker", async () => {
    // The cache is what the rail's last read left — loopback only. The server
    // has since started trusting a tailnet address (a join in another tab, or
    // the CLI). Reopening the dialog is how a person re-checks, so the open is
    // the refetch — the Nodes dialog's precedent.
    const { calls } = renderDialog({
      origin: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080"],
      serverTrustedOrigins: ["http://localhost:3080", "https://plane.tail1234.ts.net"],
    });
    expect(await screen.findByRole("img", { name: /https:\/\/plane\.tail1234\.ts\.net/ })).toBeTruthy();
    expect(calls.filter((path) => path === "/api/settings/public")).toHaveLength(1);
  });

  it("tells an admin that joining a network is enough", () => {
    renderDialog({ origin: "http://localhost:3080", trustedOrigins: ["http://127.0.0.1:3080"], admin: true });
    const note = screen.getByTestId("no-address-note");
    expect(note.textContent).toMatch(/Join a network under Server Settings → Networking/);
    expect(note.textContent).not.toMatch(/publish/i);
  });
});
