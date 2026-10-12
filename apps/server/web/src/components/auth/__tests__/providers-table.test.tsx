import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ProviderSettingsDialog } from "@/components/auth/provider-settings-dialog";
import { ProvidersTable } from "@/components/auth/providers-table";
import type { PatchAuthProviderBody, ProviderAdminView } from "@/types/auth-provider";

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

async function configure(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Configure" }));
  await screen.findByRole("dialog", { name: "Configure provider" });
}

const switchFor = (name: string): HTMLElement => screen.getByRole("switch", { name });

/** Base UI's switch root is a span, so "disabled" is an ARIA/data state, not a DOM property. */
const isDisabled = (el: HTMLElement): boolean =>
  el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");

describe("the last-open-provider guard (2026-09-25)", () => {
  afterEach(cleanup);

  it("disables the two close-capable switches of the sole open provider, and says why", async () => {
    renderTable([row("email", true, true), row("other", false, true)]);
    expect(screen.queryByRole("switch")).toBeNull();
    await configure("email");
    // OPEN means both flags on, exactly what the server's guard counts —
    // "other" has signIn on but is disabled, so "email" is the ONLY open provider.
    expect(isDisabled(switchFor("Sign-in"))).toBe(true);
    expect(isDisabled(switchFor("Enabled"))).toBe(true);
    // The explanation is on the record for every modality: an sr-only span
    // (aria-describedby carrier) repeats the rule verbatim for readers.
    expect(screen.getAllByText(/cannot disable the last provider/).length).toBeGreaterThanOrEqual(2);
    // The switches that cannot close a way in stay live.
    expect(isDisabled(switchFor("Registration"))).toBe(false);
    expect(isDisabled(switchFor("Require approval"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await configure("other");
    // A disabled provider can still be enabled again.
    expect(isDisabled(switchFor("Enabled"))).toBe(false);
  });

  it("disables nothing while two providers are open", async () => {
    renderTable([row("email", true, true), row("other", true, true)]);
    for (const id of ["email", "other"]) {
      await configure(id);
      expect(isDisabled(switchFor("Sign-in"))).toBe(false);
      expect(isDisabled(switchFor("Enabled"))).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    }
    expect(screen.queryByText(/cannot disable the last provider/)).toBeNull();
  });
  it("turns the inherited registration gate into an explicit one-field setting", async () => {
    const original = globalThis.fetch;
    const writes: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ...row("email", true, true), registrationEnabled: true }));
    }) as typeof fetch;
    try {
      renderTable([{ ...row("email", true, true), registrationEnabled: null }]);
      await configure("email");
      expect(switchFor("Registration").getAttribute("aria-checked")).toBe("false");
      fireEvent.click(switchFor("Registration"));
      await waitFor(() => expect(writes).toEqual([{ registrationEnabled: true }]));
      expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows a server refusal in the dialog without claiming the setting changed", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ message: "Provider change refused", code: "LAST_PROVIDER" }), {
        status: 409,
      })) as typeof fetch;
    try {
      renderTable([row("email", true, true), row("other", true, true)]);
      await configure("email");
      fireEvent.click(switchFor("Sign-in"));
      expect((await screen.findByRole("alert")).textContent).toContain("Provider change refused");
      expect(switchFor("Sign-in").getAttribute("aria-checked")).toBe("true");
    } finally {
      globalThis.fetch = original;
    }
  });
  it("disables subordinate settings without changing them and restores them when enabled again", () => {
    const writes: PatchAuthProviderBody[] = [];
    function Settings() {
      const [provider, setProvider] = useState({
        ...row("email", true, true),
        requireApproval: true,
        registrationEnabled: false,
      });
      return (
        <ProviderSettingsDialog
          provider={provider}
          computedOpen={false}
          soleOpen={false}
          busy={false}
          error={null}
          onClose={() => {}}
          onChange={(body) => {
            writes.push(body);
            const enabled = body.enabled;
            if (enabled !== undefined) setProvider((current) => ({ ...current, enabled }));
          }}
        />
      );
    }
    render(<Settings />);
    fireEvent.click(switchFor("Enabled"));
    for (const [name, checked] of [
      ["Sign-in", "true"],
      ["Registration", "false"],
      ["Require approval", "true"],
    ] as const) {
      const control = switchFor(name);
      expect(isDisabled(control)).toBe(true);
      expect(control.getAttribute("aria-checked")).toBe(checked);
      fireEvent.click(control);
    }
    expect(writes).toEqual([{ enabled: false }]);
    fireEvent.click(switchFor("Enabled"));
    for (const [name, checked] of [
      ["Sign-in", "true"],
      ["Registration", "false"],
      ["Require approval", "true"],
    ] as const) {
      const control = switchFor(name);
      expect(isDisabled(control)).toBe(false);
      expect(control.getAttribute("aria-checked")).toBe(checked);
    }
    expect(writes).toEqual([{ enabled: false }, { enabled: true }]);
  });
});
