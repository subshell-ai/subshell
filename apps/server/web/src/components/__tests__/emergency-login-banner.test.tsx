import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { EmergencyLoginBanner } from "@/components/emergency-login-banner";

/**
 * The banner is data-driven: it renders the alert ONLY from a seeded cache
 * entry (the same key the shell's query uses), so no fetch happens here.
 */
function renderWithCache(active: boolean) {
  const qc = new QueryClient();
  qc.setQueryData(["settings-public"], { allowRegistrations: false, emergencyLoginActive: active });
  render(
    <QueryClientProvider client={qc}>
      <EmergencyLoginBanner />
    </QueryClientProvider>,
  );
}

describe("EmergencyLoginBanner", () => {
  afterEach(cleanup);

  it("shows the alert while the hatch is armed", () => {
    renderWithCache(true);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Emergency admin login is enabled");
  });

  it("renders nothing while disarmed", () => {
    renderWithCache(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
