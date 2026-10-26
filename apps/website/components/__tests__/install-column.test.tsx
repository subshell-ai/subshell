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

test("the non-download third path points at the node setup documentation", async () => {
  await mounted();
  const link = screen.getByRole("link", { name: "Add another machine" });
  expect(link.getAttribute("href")).toBe("https://docs.subshell.sh/nodes");
});

test("the single-machine note switches back to the server install", async () => {
  await mounted();
  fireEvent.click(screen.getByRole("button", { name: "Client / Node" }));
  fireEvent.click(screen.getByRole("button", { name: "Server app" }));
  expect(screen.getByRole("button", { name: "Server" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("curl -fsSL https://subshell.sh/install-server.sh | bash")).toBeDefined();
});
