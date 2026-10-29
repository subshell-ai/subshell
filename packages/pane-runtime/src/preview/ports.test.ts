import { describe, expect, it } from "bun:test";
import { defaultCdpProbe, probeWindowMs } from "./ports.js";

/**
 * The scan's time budget, checked as arithmetic rather than on a loaded host.
 * Two pressures meet here and each has been broken on its own: a floor so a
 * slow /proc walk still lets some port be probed (otherwise the picker empties
 * while the dev server was fine all along), and a ceiling the whole pass fits
 * inside (otherwise the plane times the command out and discovery answers
 * NOTHING, the one outcome worse than a dropped tail). Asserting this through a
 * real scan needs a 9 s filesystem, so the window is a pure function.
 */
describe("probeWindowMs", () => {
  it("gives a fresh scan the window its candidate count warrants, up to the ceiling", () => {
    expect(probeWindowMs(0, 4)).toBe(2_500 + 4 * 250);
    expect(probeWindowMs(0, 100)).toBe(6_000);
  });

  it("lifts a nearly-starved scan to the probe floor", () => {
    // Five seconds of walk leaves one second under the ceiling; the floor is
    // what keeps that from answering an empty picker for a pane that has a
    // perfectly good dev server.
    expect(probeWindowMs(5_000, 4)).toBe(1_500);
  });

  it("never lets the floor outrun the plane's command budget", () => {
    // The regression this pins: the floor used to be an unconditional minimum,
    // so a 9 s walk still bought 1.5 s of probing and the command died on the
    // 10 s timeout, taking the whole answer with it.
    expect(probeWindowMs(8_000, 40)).toBe(1_000);
    expect(probeWindowMs(8_999, 40)).toBe(1);
    expect(probeWindowMs(9_000, 40)).toBe(0);
    expect(probeWindowMs(60_000, 40)).toBe(0);
  });
});

describe("the devtools probe's family slices", () => {
  it("keeps asking after a stalled IPv4 family, so an IPv6-only browser is still found", async () => {
    // This pins the CALL SITE, not just the ladder helper: drop the per-family
    // slice here and the stalled family runs to the caller's deadline, the
    // ladder reads that as the caller giving up, `::1` is never asked, and the
    // port is listed as a website yet never watched, which is what this branch
    // set out to fix. The outer signal is far longer than a family slice, so
    // only the slice can move the question along.
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("[::1]")) return Response.json({ Browser: "v6 only" });
      const signal = init?.signal;
      if (!signal) throw new Error("each family must be asked on its own slice");
      await new Promise<void>((_resolve, reject) => {
        const stop = (): void => reject(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      });
      throw new Error("unreachable: a stalled family never answers");
    }) as unknown as typeof fetch;
    try {
      await expect(defaultCdpProbe(9336, AbortSignal.timeout(4_000))).resolves.toBe(true);
      expect(asked).toEqual(["http://127.0.0.1:9336/json/version", "http://[::1]:9336/json/version"]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
