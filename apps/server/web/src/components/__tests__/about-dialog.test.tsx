import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { AboutDialog } from "@/components/about-dialog";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * The navigator's own `userAgent` descriptor, restored after every test.
 *
 * Bun runs every test FILE in one process, so a UA left overwritten here is
 * the UA the next file's components read — which is how two unrelated suites
 * started failing on a desktop marker nobody in them had set.
 */
let previousUserAgent: PropertyDescriptor | undefined;

function renderAbout(userAgent: string) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["settings-public"], {
    allowRegistrations: false,
    emergencyLoginActive: false,
    instanceName: "Prod plane",
    appBaseUrl: "http://localhost:3080",
    viewerIsAdmin: false,
    serverVersion: "0.2.0",
    nodeArtifactTargets: [],
    nodeArtifactsAutoFetch: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <AboutDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
});

describe("AboutDialog", () => {
  it("names the instance and the CLI version, with the licence and links, in a browser", () => {
    renderAbout("Mozilla/5.0");
    expect(screen.getByText("Prod plane")).toBeTruthy();
    // In a browser the CLI line is the whole truth — there is no app wrapping
    // anything here.
    expect(screen.getByText(/CLI 0\.2\.0/)).toBeTruthy();
    // No shell to name: the desktop line is absent rather than blank.
    expect(screen.queryByText(/Desktop app 0\./)).toBeNull();
    expect(screen.getByRole("link", { name: "Licence" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Website" })).toBeTruthy();
  });

  it("adds the desktop shell's version under the marker", () => {
    renderAbout("Mozilla/5.0 SubshellDesktop/0.2.0 (macos; p=1)");
    // "Desktop app" and "CLI" — the pair Subshell Client's About uses too,
    // and the words the released artifacts carry. It was "Server" and
    // "Subshell Server": two labels one word apart for two different
    // programs, which usually carry the same number anyway.
    expect(screen.getByText(/Desktop app 0\.2\.0/)).toBeTruthy();
  });
});
