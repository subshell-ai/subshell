/**
 * One thing on this instance as a QR code (operator's request, 2026-09-19).
 *
 * What these pin is the part that is genuinely this dialog's: the code carries
 * the CHOSEN address with the thing's path on the end, and none of the mobile
 * install dialog's PWA steps came along for the ride. The picker, the refusal
 * and the plate belong to `AddressQr` and are covered by
 * `mobile-install-dialog.test.tsx`, which drives the same component.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QrLinkDialog } from "@/components/qr-link-dialog";

const HERE = "http://localhost:3080";
const LAN = "http://10.0.0.5:3080";
const TAILNET = "https://box.tail1234.ts.net";

function mockFetch(trustedOrigins: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ appBaseUrl: HERE, trustedOrigins, viewerIsAdmin: false })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

function renderDialog(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QrLinkDialog
        open
        onOpenChange={() => {}}
        title="Open “demo” elsewhere"
        description="Scan to open this subshell on another device."
        path={path}
        origin={HERE}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("QrLinkDialog", () => {
  it("encodes the chosen address WITH the thing's path, not the bare origin", async () => {
    const restore = mockFetch([HERE, LAN, TAILNET]);
    try {
      renderDialog("/subshells/abc-123");
      // `installAddresses` drops loopback, so the first offered address is the
      // LAN one — which is the whole point: the origin this browser is on is
      // the one a phone cannot reach.
      const expected = `${LAN}/subshells/abc-123`;
      await waitFor(() => expect(screen.getByTitle(`QR code for ${expected}`)).toBeTruthy());
      // And the copy row hands over the same full URL, not the origin.
      expect(screen.getByText(expected)).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("carries none of the PWA install steps", async () => {
    const restore = mockFetch([HERE, LAN]);
    try {
      renderDialog("/workspaces/w-1");
      await waitFor(() => expect(screen.getByTitle(`QR code for ${LAN}/workspaces/w-1`)).toBeTruthy());
      // The gesture belongs to "put Subshell on your phone", not to "open this
      // workspace over there" — the operator asked for it left out, and a
      // shared component makes it easy to drift back in.
      expect(screen.queryByText(/Add to Home Screen/i)).toBeNull();
      expect(screen.queryByText(/Install page as app/i)).toBeNull();
      expect(screen.queryByRole("group", { name: "Where you are installing Subshell" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("says what scanning does, and that it grants nothing", async () => {
    const restore = mockFetch([HERE, LAN]);
    try {
      renderDialog("/subshells/abc-123");
      expect(screen.getByText("Open “demo” elsewhere")).toBeTruthy();
      expect(screen.getByText("Scan to open this subshell on another device.")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("shows the refusal where the QR would be when no address can be dialled", async () => {
    // A loopback-only instance: `installAddresses` filters it, so there is
    // nothing to encode — and a code for `localhost` would scan perfectly and
    // resolve, on the phone, to that phone's own port 3080.
    const restore = mockFetch([HERE]);
    try {
      renderDialog("/subshells/abc-123");
      await waitFor(() => expect(screen.getByTestId("no-address-note")).toBeTruthy());
      expect(screen.queryByTitle(/QR code for/)).toBeNull();
    } finally {
      restore();
    }
  });
});
