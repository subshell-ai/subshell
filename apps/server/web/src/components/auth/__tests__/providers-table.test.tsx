import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { ProvidersTable } from "@/components/auth/providers-table";
import type { ProviderAdminView } from "@/types/auth-provider";

/** A row with the table's minimum vocabulary; the guard reads two flags only. */
function row(id: string, enabled: boolean, signInEnabled: boolean): ProviderAdminView {
  return {
    id,
    kind: id === "email" ? "email" : "oidc",
    name: id,
    issuer: id === "email" ? null : `https://${id}.example`,
    clientId: id === "email" ? null : "client-1",
    hasSecret: false,
    entryOrigins: ["https://plane.example"],
    allowedDomains: null,
    enabled,
    signInEnabled,
    registrationEnabled: true,
    requireApproval: false,
    endpointsResolved: true,
  };
}

function renderTable(providers: ProviderAdminView[]): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ProvidersTable providers={providers} registrationComputedOpen={false} onEdit={() => {}} />
    </QueryClientProvider>,
  );
}

const switchFor = (name: string): HTMLElement => screen.getByRole("switch", { name });

/** Base UI's switch root is a span, so "disabled" is an ARIA/data state, not a DOM property. */
const isDisabled = (el: HTMLElement): boolean =>
  el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");

describe("the last-open-provider guard (2026-09-25)", () => {
  afterEach(cleanup);

  it("disables the two close-capable switches of the sole open provider, and says why", () => {
    renderTable([row("email", true, true), row("other", false, true)]);
    // OPEN means both flags on, exactly what the server's guard counts —
    // "other" has signIn on but is disabled, so "email" is the ONLY open door.
    expect(isDisabled(switchFor("Sign-in for email"))).toBe(true);
    expect(isDisabled(switchFor("Enabled for email"))).toBe(true);
    // The explanation is on the record for every modality: an sr-only span
    // (aria-describedby carrier) repeats the rule verbatim for readers.
    expect(screen.getAllByText(/cannot disable the last provider/).length).toBeGreaterThanOrEqual(2);
    // The switches that cannot close the door stay live.
    expect(isDisabled(switchFor("Registration for email"))).toBe(false);
    expect(isDisabled(switchFor("Approval required for email"))).toBe(false);
    // The already-closed row is not the last door: its switches move freely.
    expect(isDisabled(switchFor("Enabled for other"))).toBe(false);
  });

  it("disables nothing while two providers are open", () => {
    renderTable([row("email", true, true), row("other", true, true)]);
    for (const id of ["email", "other"]) {
      expect(isDisabled(switchFor(`Sign-in for ${id}`))).toBe(false);
      expect(isDisabled(switchFor(`Enabled for ${id}`))).toBe(false);
    }
    expect(screen.queryByText(/cannot disable the last provider/)).toBeNull();
  });
});
