import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrustNoticeBanner, VISIBLE_MS } from "@/components/trust-notice-banner";
import { noticeSeen, setTrustBannersEnabled } from "@/lib/trust-notice-prefs";
import type { TrustNotice } from "@/lib/trust-notices";

function notice(over: Partial<TrustNotice> = {}): TrustNotice {
  return {
    kind: "shared",
    dismissKey: "shared:s1:2:false",
    banner: "You've shared this subshell with 2 other people.",
    tooltip: "Shared with 2 other people.",
    label: "Shared with 2 other people",
    ...over,
  };
}

describe("TrustNoticeBanner", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("shows the disclosure, then retires it without being touched", async () => {
    // A SHORT dwell, not a fake clock. The contract under test is "it goes
    // away on its own", so the timers stay real — asserting this through fake
    // timers would test the mock instead. At the 5 s default this case spent
    // 5.4 s of wall clock and, on a loaded CI runner, blew past even a 15 s
    // budget (17.2 s, one failed run on 2026-09-07). The default itself is
    // pinned separately below, so nothing here stops covering it.
    render(<TrustNoticeBanner notices={[notice()]} visibleMs={80} />);
    expect(screen.getByRole("alert").textContent).toContain("shared this subshell with 2 other people");

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 4000 });
    // ...and having been shown once, it does not come back.
    expect(noticeSeen("shared:s1:2:false")).toBe(true);
  });

  // The dwell the app actually ships. The case above proves the retire path
  // with a short one, so without this the 5 s product decision would be
  // asserted nowhere and could be changed by accident.
  it("dwells for five seconds by default", () => {
    expect(VISIBLE_MS).toBe(5_000);
  });

  it("retires when dismissed, well before the 5 s dwell, and remembers that", async () => {
    render(<TrustNoticeBanner notices={[notice()]} />);
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    // The dismissal is what is under test, not the fade's exact duration — so
    // wait on the observable OUTCOME with a budget generous enough to survive
    // a loaded suite, then prove it beat the automatic path rather than
    // racing it.
    await waitFor(() => expect(noticeSeen("shared:s1:2:false")).toBe(true), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 4000 });
  }, 15_000);

  it("stays quiet for an exposure already seen on this device", () => {
    localStorage.setItem("subshell.trustNoticesSeen", JSON.stringify(["shared:s1:2:false"]));
    render(<TrustNoticeBanner notices={[notice()]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("raises a fresh banner when the audience widens", () => {
    // The same subshell, a bigger share: new information, not a dismissal to
    // honour. The key carries the exposure precisely so this works.
    localStorage.setItem("subshell.trustNoticesSeen", JSON.stringify(["shared:s1:2:false"]));
    render(<TrustNoticeBanner notices={[notice({ dismissKey: "shared:s1:5:false", banner: "Now five." })]} />);
    expect(screen.getByRole("alert").textContent).toContain("Now five.");
  });

  it("shows nothing when the device has banners switched off", () => {
    setTrustBannersEnabled(false);
    render(<TrustNoticeBanner notices={[notice()]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one notice at a time, most serious first", () => {
    // Two amber strips over a terminal bury the output being warned about.
    // The icons show both regardless; the banners queue.
    render(
      <TrustNoticeBanner
        notices={[
          notice({ kind: "foreign-node", dismissKey: "node:s1:n1", banner: "Runs on someone else's machine." }),
          notice(),
        ]}
      />,
    );
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Runs on someone else's machine.");
  });

  it("renders nothing when there is nothing to disclose", () => {
    render(<TrustNoticeBanner notices={[]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
