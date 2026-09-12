import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

let ipc: FakeIpc | undefined;

// Without this the rendered tree and the installed fake outlive the case, and
// the next one queries a stale document — which is how these first failed:
// "Subshell Client" is the page HEADER as well as the footer's heading, so a
// wait on it resolved against the previous render before About had loaded.
afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/** The payload `node_about` answers, shaped like Rust's `About`. */
const ABOUT = {
  productName: "Subshell",
  appName: "Subshell Client",
  appVersion: "0.1.3",
  copyright: "Copyright 2026 Disaresta, LLC",
  company: "Disaresta, LLC",
  licenseSummary: "AGPL-3.0-only (control plane), Apache-2.0 elsewhere",
  websiteUrl: "https://subshell.sh",
  licenseUrl: "https://github.com/subshell-ai/subshell/blob/main/LICENSE",
  companyUrl: "https://disaresta.com",
};

async function bootWithAbout(probe = makeProbe({ agent: { argv: ["subshell"], source: "path", version: "0.2.0" } })) {
  ipc = installFakeIpc({
    probe,
    settings: makeSettings(),
    handlers: { node_about: () => ABOUT, node_open_web: () => null },
  });
  renderApp(<App />);
  // The copyright, not the app name: the page header says "Subshell Client"
  // too, so waiting on that would resolve before the footer had its data.
  await screen.findByText(ABOUT.copyright);
  return ipc;
}

describe("the About footer", () => {
  it("names the app, both versions, the terms and the owner", async () => {
    await bootWithAbout();
    // Two different programs, one line — which is what a bug report needs.
    expect(screen.getByText("Version 0.1.3 · Agent 0.2.0")).toBeDefined();
    expect(screen.getByText(ABOUT.licenseSummary)).toBeDefined();
    expect(screen.getByText(ABOUT.copyright)).toBeDefined();
  });

  it("omits the agent version when no agent resolves rather than inventing one", async () => {
    await bootWithAbout(makeProbe({ agent: null }));
    expect(screen.getByText("Version 0.1.3")).toBeDefined();
    expect(screen.queryByText(/· Agent/)).toBeNull();
  });

  it("opens a link by NAMING it, never by handing Rust a URL", async () => {
    // The boundary this app keeps everywhere: the page names a member of a
    // closed set and the Rust side decides what that member is. The addresses
    // travel here for display, and sending one back would make display and
    // navigation the same capability.
    const fake = await bootWithAbout();
    fireEvent.click(screen.getByRole("button", { name: "Website" }));
    await waitFor(() => expect(fake.callsTo("node_open_web").length).toBe(1));
    expect(fake.callsTo("node_open_web")[0]).toEqual({ target: "website" });

    fireEvent.click(screen.getByRole("button", { name: "Disaresta, LLC" }));
    await waitFor(() => expect(fake.callsTo("node_open_web").length).toBe(2));
    expect(fake.callsTo("node_open_web")[1]).toEqual({ target: "company" });

    // Nothing sent to Rust carries an address, on any call.
    for (const args of fake.callsTo("node_open_web")) {
      expect(JSON.stringify(args)).not.toContain("http");
    }
  });

  it("reads the constants ONCE — they cannot change while the app runs", async () => {
    // Compiled-in strings, so this must not ride along with the probe, which
    // re-reads the machine on every poll and on every Refresh.
    const fake = await bootWithAbout();
    expect(fake.callsTo("node_about").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(fake.callsTo("node_probe").length).toBeGreaterThan(1));
    expect(fake.callsTo("node_about").length).toBe(1);
  });

  it("renders nothing at all when the read fails, rather than a half-empty box", async () => {
    // An About surface missing its version and its copyright says less than no
    // About surface, and this one is a footer nobody navigated to.
    ipc = installFakeIpc({ probe: makeProbe(), settings: makeSettings() });
    renderApp(<App />);
    // The page is up (its own control), and the footer simply is not there.
    await screen.findByRole("button", { name: /Refresh/ });
    await waitFor(() => expect(ipc?.callsTo("node_about").length).toBe(1));
    expect(screen.queryByText(/Copyright/)).toBeNull();
  });
});
