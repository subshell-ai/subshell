import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrustNoticeBanner } from "@/components/trust-notice-banner";
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
    render(<TrustNoticeBanner notices={[notice()]} />);
    expect(screen.getByRole("alert").textContent).toContain("shared this subshell with 2 other people");

    // 5 s visible + 400 ms fade. Real timers with a generous budget: the
    // component's contract is "it goes away on its own", and asserting that
    // through fake timers would test the mock instead.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 8000 });
    // ...and having been shown once, it does not come back.
    expect(noticeSeen("shared:s1:2:false")).toBe(true);
    // Explicit case timeout: the banner's whole point is a 5 s dwell, which
    // is past bun's 5 s default — without this the case is killed mid-wait
    // and fails as a bogus assertion rather than a timeout.
  }, 15_000);

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
