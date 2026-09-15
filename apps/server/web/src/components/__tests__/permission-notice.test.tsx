import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionNotice } from "@/components/desktop/permission-notice";
import { NotificationsCard } from "@/components/notifications-card";
import { TerminalDropOverlay } from "@/components/terminal-drop-overlay";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { PERMISSIONS, type Permission } from "@/types/permissions";

/**
 * The shape every "macOS is blocking this" notice takes (spec 2026-09-14 §5),
 * and the standing home for the recovery (§5.4).
 *
 * The rule the notice exists to keep: the dashboard NEVER opens a System
 * Settings pane itself. Fix… raises the bundled assistant, which is the one
 * surface granted the command that does — so in a browser, where no app is
 * there to raise, the same instruction is given in words rather than as a
 * button that cannot work.
 */

const SERVER_UA = "Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)";
const SERVER_LINUX_UA = "Mozilla/5.0 SubshellDesktop/1.0.0 (linux; p=1)";
const CLIENT_UA = "Mozilla/5.0 SubshellClient/1.0.0 (macos; p=1)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

/** Point `navigator.userAgent` at one shell (or none) for the next render. */
function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

/** Every invoke the page made, so the raised screen can be asserted. */
const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];

/** A fake `window.__TAURI__` answering `desktop_permissions` with `permissions`. */
function fakeTauri(permissions: { notifications: Permission; photos: Permission }) {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return Promise.resolve(command === "desktop_permissions" ? permissions : null);
      },
    },
  };
}

afterEach(() => {
  cleanup();
  invocations.length = 0;
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  // No own descriptor means the real one lives on the prototype — deleting the
  // one `setUA` defined is what uncovers it again. Without this branch the
  // overwritten UA outlives the file, and the next file's components read it.
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
});

describe("PermissionNotice", () => {
  it("offers Fix… inside Subshell Server, and raises the assistant at the permissions screen", async () => {
    setUA(SERVER_UA);
    fakeTauri({ notifications: "denied", photos: "denied" });
    render(<PermissionNotice pane="photos" message="macOS is blocking the Photos library." />);
    fireEvent.click(screen.getByRole("button", { name: "Fix…" }));
    await waitFor(() => expect(invocations).toHaveLength(1));
    expect(invocations[0]).toEqual({ command: "desktop_open_assistant", args: { screen: "permissions" } });
  });

  it("gives the System Settings path in words in a browser, and offers no button", () => {
    setUA(BROWSER_UA);
    render(<PermissionNotice pane="photos" message="macOS is blocking the Photos library." />);
    expect(screen.queryByRole("button", { name: "Fix…" })).toBeNull();
    expect(screen.getByText(/System Settings → Privacy & Security → Photos/)).toBeTruthy();
  });

  it("gives words inside Subshell Client too — it holds no assistant to raise", () => {
    setUA(CLIENT_UA);
    render(<PermissionNotice pane="notifications" message="Blocked." />);
    expect(screen.queryByRole("button", { name: "Fix…" })).toBeNull();
    expect(screen.getByText(/System Settings → Notifications → Subshell Server/)).toBeTruthy();
  });

  it("names the System Settings pane for a permission only macOS asks about", () => {
    setUA(BROWSER_UA);
    render(<PermissionNotice pane="notifications" message="Blocked." />);
    expect(screen.getByText(/System Settings → Notifications/)).toBeTruthy();
  });

  // A FILES refusal is the server's own EACCES/EPERM, on every platform. From
  // a browser this page cannot see which OS the server runs, and on Linux the
  // fix is unix modes, not System Settings — so the path is named only where
  // the shell says the server is on a Mac (review, 2026-09-14).
  it("does not send a browser to System Settings for a refused folder", () => {
    setUA(BROWSER_UA);
    render(<PermissionNotice pane="files" message="Blocked." />);
    expect(screen.queryByText(/System Settings/)).toBeNull();
    expect(screen.getByText("Blocked.")).toBeTruthy();
  });
});

describe("Preferences → Notifications: the live macOS line", () => {
  /** The card with push reporting "unsupported", which is what a webview does. */
  function renderCard() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NotificationsCard getState={async () => "unsupported"} enable={async () => "on"} disable={async () => "off"} />
      </QueryClientProvider>,
    );
  }

  const LINES: Record<Permission, string> = {
    authorized: "macOS permission: Allowed",
    provisional: "macOS permission: Allowed",
    denied: "macOS permission: Not allowed",
    "not-determined": "macOS permission: Not yet asked",
    unavailable: "macOS permission: Unavailable in this build",
  };

  for (const permission of PERMISSIONS) {
    it(`says "${LINES[permission]}"`, async () => {
      setUA(SERVER_UA);
      fakeTauri({ notifications: permission, photos: "authorized" });
      renderCard();
      await waitFor(() => expect(screen.getByText(LINES[permission])).toBeTruthy());
      // Fix… only where it leads somewhere. A denial leads to System Settings
      // (macOS will not prompt twice); not-yet-asked leads to the assistant's
      // Allow button, which someone who pressed Continue without pressing it
      // otherwise has no route back to (review, 2026-09-14). Allowed and
      // unavailable have nothing to press.
      const fix = screen.queryByRole("button", { name: "Fix…" });
      expect(fix !== null).toBe(permission === "denied" || permission === "not-determined");
    });
  }

  it("says nothing about macOS in a browser — it is not a fact about this device", async () => {
    setUA(BROWSER_UA);
    renderCard();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.queryByText(/macOS permission/)).toBeNull();
  });

  // The Linux build answers `unavailable` to `desktop_permissions` — it has no
  // such permission to report on — and the card rendered that verbatim as
  // "macOS permission: Unavailable in this build" on a machine that has never
  // run macOS (review, 2026-09-14). The shell alone is not the question; the
  // platform is the other half of it.
  it("says nothing about macOS in the Linux shell, where there is no such permission", async () => {
    setUA(SERVER_LINUX_UA);
    fakeTauri({ notifications: "unavailable", photos: "unavailable" });
    renderCard();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.queryByText(/macOS permission/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix…" })).toBeNull();
  });
});

describe("the terminal's Photos notice", () => {
  /** The overlay as the terminal mounts it, with nothing else going on. */
  function renderOverlay(photosBlocked: boolean) {
    render(
      <TerminalDropOverlay
        isDragActive={false}
        entries={[]}
        error={null}
        onDismiss={() => {}}
        photosBlocked={photosBlocked}
        onDismissPhotosNotice={() => {}}
      />,
    );
  }

  it("says what will not attach, and that folders still work", () => {
    setUA(SERVER_UA);
    renderOverlay(true);
    expect(screen.getByText(/images picked from Photos will not attach/)).toBeTruthy();
    expect(screen.getByText(/Files from folders still work/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix…" })).toBeTruthy();
  });

  it("is absent when Photos is not blocked", () => {
    setUA(SERVER_UA);
    renderOverlay(false);
    expect(screen.queryByText(/Photos library/)).toBeNull();
  });

  // Not an `alert`: nothing failed. The picker opened and folder uploads work.
  it("is a status, not an error", () => {
    setUA(SERVER_UA);
    renderOverlay(true);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
