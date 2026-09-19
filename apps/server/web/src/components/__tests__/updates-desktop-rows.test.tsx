import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { updatesView } from "@/components/__tests__/helpers/updates-view";
import { DesktopRows, releasePageUrl } from "@/components/updates/desktop-rows";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * The rows ask `desktopShell()`, which parses (and memoizes) the User-Agent,
 * so the three surfaces are three UAs. Stubbing the UA — not the module — is
 * the same route `open-in-browser.test.tsx` takes, and it exercises the real
 * app-version parsing the behind-check runs on.
 */
const SERVER_BEHIND_UA = "Mozilla/5.0 SubshellDesktop/0.6.0 (macos; p=1; b=0.6.0)";
const SERVER_CURRENT_UA = "Mozilla/5.0 SubshellDesktop/0.7.0 (macos; p=1; b=0.7.0)";
const CLIENT_UA = "Mozilla/5.0 SubshellClient/0.3.0 (linux; p=1)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

afterEach(() => {
  cleanup();
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
});

/**
 * The fixture's releases: desktop-server 0.7.0, desktop-client 0.5.0. The rows
 * are `contents` fragments; a grid div is their real parent on the page.
 */
function renderRows(desktop = updatesView().desktop, apps?: readonly ("server" | "client")[]) {
  return render(
    <div className="grid">
      <DesktopRows desktop={desktop} apps={apps} />
    </div>,
  );
}

describe("a browser", () => {
  it("links to the release pages, and offers no button", () => {
    setUA(BROWSER_UA);
    renderRows();
    const links = screen.getAllByRole("link", { name: "Notes" }) as HTMLAnchorElement[];
    expect(links.map((a) => a.href)).toEqual([
      releasePageUrl("desktop-server-v0.7.0"),
      releasePageUrl("desktop-client-v0.5.0"),
    ]);
    // A browser cannot install anything on a machine it is not running on.
    expect(screen.queryByRole("button")).toBeNull();
    // Neither app's version is knowable from here, so both Running cells are "—".
    expect(screen.getAllByText("—", { exact: true }).length).toBe(2);
  });

  it("says so when the release source answered with neither app", () => {
    setUA(BROWSER_UA);
    renderRows({ server: null, client: null });
    expect(screen.getByText(/No desktop release could be read/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("inside Subshell Server", () => {
  /**
   * This component no longer draws Subshell Server's own row in that app
   * (spec 2026-09-18 D4) — `UpdatesTable` asks it for the client alone and
   * `folded-server-row.tsx` carries the server, because the app SHIPS the
   * server and updating them separately was our packaging presented as the
   * user's decision.
   *
   * What is pinned here is that the row is GONE rather than merely
   * button-less: the branch that drew the button required `shell.app ===
   * "server"`, so leaving it in place would have been unreachable code
   * claiming to be a surface.
   */
  it("draws no server row when it is asked for the client alone", () => {
    setUA(SERVER_BEHIND_UA);
    renderRows(undefined, ["client"]);
    expect(screen.queryByText("Subshell Server app", { exact: true })).toBeNull();
    expect(screen.getByText("Subshell Client app", { exact: true })).toBeTruthy();
    // No button anywhere: this surface cannot install the OTHER app, and the
    // one it could install is not its row any more.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers a button for its own row, even when asked for both", () => {
    setUA(SERVER_BEHIND_UA);
    renderRows();
    expect(screen.queryByRole("button", { name: "Open the update assistant" })).toBeNull();
    // Still no links: a link is the browser's answer, not the app's.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers no act at all when its own row is up to date", () => {
    setUA(SERVER_CURRENT_UA);
    renderRows();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    // The equal version cells say it: Running and Newest both 0.7.0 on that row.
    expect(screen.getAllByText("0.7.0", { exact: true }).length).toBe(2);
  });
});

describe("inside Subshell Client", () => {
  it("gives its own behind row the tray sentence, never a button", () => {
    setUA(CLIENT_UA);
    renderRows();
    expect(screen.getByText("Open the tray menu → This Machine… → Update.")).toBeTruthy();
    // Its remote window holds exactly one command, and it is not this one.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
