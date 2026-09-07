import { describe, expect, it } from "bun:test";
import { type ProbeDeps, probeInstance } from "@/lib/probe";

const up = async () => ({ needsSetup: false });
const down = async (): Promise<{ needsSetup: boolean }> => {
  throw new Error("unreachable");
};
const sock = (opened: boolean, closeCode: number | null) => async () => ({ opened, closeCode });

function deps(rest: ProbeDeps["fetchSetupStatus"], ws: ProbeDeps["openProbeSocket"]): ProbeDeps {
  return { fetchSetupStatus: rest, openProbeSocket: ws };
}

describe("probeInstance", () => {
  it("REST down → down, ws verdict withheld (nothing else can be concluded)", async () => {
    expect(await probeInstance("https://x", deps(down, sock(true, null)))).toEqual({
      ok: false,
      needsSetup: false,
      wsBlocked: false,
    });
  });

  it("REST up + socket opens → ws reachable", async () => {
    expect(await probeInstance("https://x", deps(up, sock(true, null)))).toEqual({
      ok: true,
      needsSetup: false,
      wsBlocked: false,
    });
  });

  it("REST up + 4001/4004 close → upgrade reached the server → ws reachable", async () => {
    // An unauthenticated probe token is always rejected — a 4xxx close PROVES
    // the proxy forwards upgrades (spec §Error handling).
    for (const code of [4001, 4004]) {
      expect((await probeInstance("https://x", deps(up, sock(false, code)))).wsBlocked).toBe(false);
    }
  });

  it("REST up + error/timeout with no close code → WS blocked → standing banner", async () => {
    const r = await probeInstance("https://x", deps(up, sock(false, null)));
    expect(r).toEqual({ ok: true, needsSetup: false, wsBlocked: true });
  });

  it("carries needsSetup through from the status probe", async () => {
    const r = await probeInstance(
      "https://x",
      deps(async () => ({ needsSetup: true }), sock(true, null)),
    );
    expect(r.needsSetup).toBe(true);
    expect(r.ok).toBe(true);
  });
});
