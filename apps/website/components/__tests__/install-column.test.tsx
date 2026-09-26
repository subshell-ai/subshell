import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReleasesManifest } from "../../lib/releases";
import { InstallColumn } from "../install-column";

afterEach(cleanup);

// The column refreshes the baked manifest once on mount; the test says no
// to the network and the component keeps the manifest it was given (the
// refresh's own fallback, exercised for real by the releases tests). The
// real fetch is put back: bun shares one globalThis across the files that
// shard into this process, and a permanently-dead fetch is the kind of
// landmine the next file steps on.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => Promise.reject(new Error("offline test"))) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const m = {
  schemaVersion: 1,
  generatedAt: "x",
  components: {
    "cli-server": {
      version: "0.16.0",
      tag: "cli-server-v0.16.0",
      url: "https://x",
      installScript: "install-server.sh",
    },
    "desktop-server": { version: "0.16.0", tag: "desktop-server-v0.16.0", url: "https://ds" },
    "desktop-client": {
      version: "0.6.0",
      tag: "desktop-client-v0.6.0",
      url: "https://dc",
      installScript: "install-client.sh",
    },
  },
} as ReleasesManifest;

/** Render and let the mount effect (Mac detection, the refused refresh) land. */
async function mounted() {
  render(<InstallColumn manifest={m} />);
  await act(async () => {});
}

// Issue #233: the fork must name each choice by the machine's JOB, carry one
// sentence saying what the picked job IS, and offer the non-download path
// (add a machine to a plane that already runs) on the same surface.
test("the fork names jobs, not product names, and states the picked role", async () => {
  await mounted();
  expect(screen.getByRole("group", { name: "What this machine should do" })).toBeDefined();
  expect(screen.getByRole("button", { name: "run the control plane" })).toBeDefined();
  expect(screen.getByRole("button", { name: "run agents here, or watch" })).toBeDefined();
  expect(screen.getByText("This machine becomes the control plane every other device connects to.")).toBeDefined();
});

test("picking the client chip says what the client is, node enrollment included", async () => {
  await mounted();
  fireEvent.click(screen.getByRole("button", { name: "run agents here, or watch" }));
  expect(
    screen.getByText("Your interface to Subshell, and the app that enrolls this machine as a node."),
  ).toBeDefined();
  // Exactly one role sentence stands: both rendering at once would re-ask the fork's own question.
  expect(screen.queryByText("This machine becomes the control plane every other device connects to.")).toBeNull();
});

test("the non-download third path points at the docs add-a-machine page", async () => {
  await mounted();
  const link = screen.getByRole("link", { name: "Add another machine" });
  expect(link.getAttribute("href")).toBe("https://docs.subshell.sh/get-started/add-a-machine");
});
