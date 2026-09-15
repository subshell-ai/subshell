import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { updatesView } from "@/components/__tests__/helpers/updates-view";
import { DesktopCard, desktopRowText, releasePageUrl } from "@/components/updates/desktop-card";
import type { DesktopShell } from "@/lib/desktop";

afterEach(cleanup);

const shell = (over: Partial<DesktopShell> = {}): DesktopShell => ({
  app: "server",
  version: "0.6.0",
  platform: "macos",
  protocol: 1,
  ...over,
});

const release = (version: string, tag: string) => ({ version, tag, publishedAt: null });

describe("desktopRowText", () => {
  it("tells the app reading its OWN row how far behind it is", () => {
    expect(desktopRowText("server", release("0.7.0", "desktop-server-v0.7.0"), shell())).toBe(
      "Subshell Server 0.7.0 is available; this app is 0.6.0.",
    );
  });

  it("says so when the app reading its own row is current", () => {
    expect(desktopRowText("server", release("0.6.0", "desktop-server-v0.6.0"), shell())).toBe(
      "Subshell Server 0.6.0 — this app is up to date.",
    );
  });

  it("states the OTHER app's release as a fact, since this page cannot know its version", () => {
    expect(desktopRowText("client", release("0.5.0", "desktop-client-v0.5.0"), shell())).toBe(
      "Subshell Client 0.5.0 is the newest release.",
    );
    // A browser is in the same position about both.
    expect(desktopRowText("server", release("0.7.0", "desktop-server-v0.7.0"), null)).toBe(
      "Subshell Server 0.7.0 is the newest release.",
    );
  });

  it("says nothing at all when there is no release to name", () => {
    expect(desktopRowText("server", null, shell())).toBeNull();
  });
});

describe("DesktopCard", () => {
  it("links to the release pages in a browser, and offers no button", () => {
    render(<DesktopCard desktop={updatesView().desktop} />);
    const links = screen.getAllByRole("link", { name: "Release notes and downloads" }) as HTMLAnchorElement[];
    expect(links.map((a) => a.href)).toEqual([
      releasePageUrl("desktop-server-v0.7.0"),
      releasePageUrl("desktop-client-v0.5.0"),
    ]);
    // A browser cannot install anything on a machine it is not running on.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says so when the release source answered with neither app", () => {
    render(<DesktopCard desktop={{ server: null, client: null }} />);
    expect(screen.getByText(/No desktop release could be read/)).toBeTruthy();
  });
});
