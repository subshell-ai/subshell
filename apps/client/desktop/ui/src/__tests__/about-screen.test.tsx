import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { AboutScreen } from "@/components/assistant/about-screen";
import { installFakeIpc, makeProbe, renderApp } from "./harness";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own. That is exactly
// how the Welcome screen's "Continue is the only control" case passed on a Mac
// and failed on CI, counting four About-screen buttons as its own (2026-09-18).
afterEach(cleanup);

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

const shell = { title: "About Subshell Client", subtitle: "What this app is." };

describe("the About screen", () => {
  it("states the app's version, the terms and the owner", async () => {
    const fake = installFakeIpc({ handlers: { node_about: () => ABOUT } });
    try {
      renderApp(<AboutScreen shell={shell} probe={undefined} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByText(/Desktop app 0\.1\.3/)).toBeTruthy());
      expect(screen.getByText(ABOUT.licenseSummary)).toBeTruthy();
      expect(screen.getByText(ABOUT.copyright)).toBeTruthy();
      // The links are NAMED, never rendered as three addresses side by side.
      expect(screen.getByRole("button", { name: "Licence" })).toBeTruthy();
      expect(screen.queryByText(ABOUT.licenseUrl)).toBeNull();
    } finally {
      fake.restore();
    }
  });

  /**
   * The version PAIR is what an About box is opened for — usually to put in a
   * bug report — and the agent's comes from the probe rather than from
   * `node_about`, because it is a different program's version.
   */
  it("labels the two programs 'Desktop app' and 'CLI', not by product name", async () => {
    const fake = installFakeIpc({ handlers: { node_about: () => ABOUT } });
    try {
      const probe = makeProbe();
      renderApp(<AboutScreen shell={shell} probe={probe} onClose={() => {}} />);
      // The same pair Subshell Server's About uses, and the words the released
      // artifacts carry — so the distinction is learned once, not per app.
      await waitFor(() => expect(screen.getByText(/Desktop app 0\.1\.3/)).toBeTruthy());
      // The product name is NOT repeated here: the frame's title already says
      // "About Subshell Client", and this line's job is to say which of the
      // two programs the number belongs to.
      expect(screen.queryByText(/Subshell Client 0\.1\.3/)).toBeNull();
      if (probe.nodeBinary?.version) {
        expect(screen.getByText(`CLI ${probe.nodeBinary.version}`)).toBeTruthy();
      }
    } finally {
      fake.restore();
    }
  });
});

describe("the leave button", () => {
  it("renders only where the rail is not (operator ruling 2026-09-22)", () => {
    // Rail-less — the tray raised About mid-walk: Back is the only way out.
    renderApp(
      <AboutScreen
        shell={{ title: "About Subshell Client", subtitle: undefined, problem: "" }}
        probe={undefined}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeNull();
    cleanup();
    // With the rail, a select leaves; Back would answer a question the rail
    // already answers.
    renderApp(
      <AboutScreen
        shell={{ title: "About Subshell Client", subtitle: undefined, problem: "" }}
        probe={undefined}
        rail={<div />}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
