import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

/**
 * A machine whose service is stopped — the one screen that carries Refresh,
 * which is what the "read once" case needs to force a re-probe without waiting
 * out the 5 s poll.
 */
const STOPPED = makeProbe({
  step: "stopped",
  agent: { argv: ["subshell"], source: "path", version: "0.2.0" },
  service: {
    installed: true,
    definitionPath: "/home/u/.config/systemd/user/subshell.service",
    state: "stopped",
    pid: null,
    enabled: true,
    paneSafety: "keeps",
    detail: "",
  },
});

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
  // The company LINK, not the app name: it exists only once About has landed,
  // where a heading or a version number could resolve against the assistant's
  // own chrome first.
  await screen.findByRole("button", { name: ABOUT.company });
  return ipc;
}

describe("the About footer", () => {
  // ONE LINE under the assistant's bottom bar (spec 2026-09-12 § 6.4), where
  // the card page had room for a full colophon. What survives is what an About
  // is opened for — the version pair, to put in a bug report — plus the terms
  // and the owner as named links a click away.
  it("names the app and both versions on one line, with the terms and the owner as links", async () => {
    await bootWithAbout();
    expect(screen.getByText(/Subshell Client 0\.1\.3 · Agent 0\.2\.0/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Licence" })).toBeDefined();
    expect(screen.getByRole("button", { name: ABOUT.company })).toBeDefined();
    expect(screen.getByRole("button", { name: "Website" })).toBeDefined();
  });

  it("omits the agent version when no agent resolves rather than inventing one", async () => {
    await bootWithAbout(makeProbe({ agent: null }));
    expect(screen.getByText(/Subshell Client 0\.1\.3/)).toBeDefined();
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
    const fake = await bootWithAbout(STOPPED);
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
    await screen.findByRole("button", { name: "Open Subshell Client" });
    // Once, and only once, even though the assistant remounted this footer on
    // its way from the checking screen to the machine's own: a failed read of
    // a compiled-in constant has nothing to retry for.
    await waitFor(() => expect(ipc?.callsTo("node_about").length).toBe(1));
    expect(screen.queryByRole("button", { name: ABOUT.company })).toBeNull();
    expect(screen.queryByRole("button", { name: "Licence" })).toBeNull();
  });
});
