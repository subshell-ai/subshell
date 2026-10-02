import { describe, expect, it } from "bun:test";
import type { LogWindowReader } from "../log-tail.js";
import {
  createSentinelScanner,
  EXEC_MAX_OUTPUT_BYTES,
  execOutputTail,
  execSentinelCommand,
  execSentinelToken,
  execTimeoutMs,
  probeQuiet,
  waitSentinel,
  windowIsPartial,
} from "../pane-exec.js";

const enc = new TextEncoder();

/** A reader over a fixed log: pulls advance a cursor like the real windows do. */
function readerOver(bytes: Uint8Array, windowSize = 64): LogWindowReader {
  return async (fromByte, maxBytes) => {
    const end = Math.min(bytes.byteLength, fromByte + Math.min(maxBytes, windowSize));
    return { bytes: bytes.subarray(fromByte, end), next: end, size: bytes.byteLength };
  };
}

const sleepNoop = async () => {};
const clock = (() => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
})();

describe("sentinel composition", () => {
  it("token is 16 lowercase hex chars; command is the exact printf line", () => {
    expect(execSentinelToken()).toMatch(/^[0-9a-f]{16}$/);
    expect(execSentinelCommand("aabbccddeeff0011")).toBe(`printf '__xcomm_aabbccddeeff0011_DONE rc=%s\\n' "$?"`);
  });
});

describe("scanner recognition", () => {
  it("matches the whole-stream sentinel, records output before it, and reports the window index", () => {
    const s = createSentinelScanner("t0");
    expect(s.push(["working dir ok", "build started"], false)).toBeNull();
    const hit = s.push(["__xcomm_t0_DONE rc=0"], false);
    expect(hit).toEqual({ rc: 0, hitInWindow: 0 });
    expect(s.output()).toEqual(["working dir ok", "build started"]);
  });

  it("the typed echo never matches (it carries quotes and a literal $?)", () => {
    const s = createSentinelScanner("t1");
    const echo = `$ printf '__xcomm_t1_DONE rc=%s\\n' "$?"`;
    expect(s.push([echo], false)).toBeNull();
  });

  it("a fish-shaped empty rc never matches and the stream keeps accumulating", () => {
    const s = createSentinelScanner("t2");
    expect(s.push(["__xcomm_t2_DONE rc="], false)).toBeNull();
    expect(s.output()).toEqual(["__xcomm_t2_DONE rc="]); // ordinary text, not a hit, not lost
  });

  it("a partial tail line is carried, matched when completed by the next window", () => {
    const s = createSentinelScanner("t3");
    expect(s.push(["noise"], false)).toBeNull();
    expect(s.push(["__xcomm_t3_DO"], true)).toBeNull(); // split read 1: NO match, held
    const hit = s.push(["NE rc=3"], false); // split read 2: merged line matches
    expect(hit).toEqual({ rc: 3, hitInWindow: 0 });
    expect(s.output()).toEqual(["noise"]);
  });

  it("windowIsPartial is the no-newline rule of S1's liveness branch", () => {
    expect(windowIsPartial(enc.encode("abc"))).toBe(true);
    expect(windowIsPartial(enc.encode("ab\nc"))).toBe(false);
    expect(windowIsPartial(new Uint8Array(0))).toBe(false);
  });
});

describe("execTimeoutMs clamping", () => {
  it("defaults, floors, and caps exactly", () => {
    expect(execTimeoutMs(undefined)).toBe(30_000);
    expect(execTimeoutMs(1)).toBe(1_000);
    expect(execTimeoutMs(9_999_999)).toBe(300_000);
    expect(execTimeoutMs(45_000)).toBe(45_000);
  });
});

describe("probeQuiet", () => {
  it("same size across the two probes means quiet, and reports the size", async () => {
    let calls = 0;
    const read: LogWindowReader = async () => {
      calls += 1;
      return { bytes: new Uint8Array(0), next: 0, size: 77 };
    };
    const r = await probeQuiet(read, sleepNoop);
    expect(r).toEqual({ quiet: true, size: 77 });
    expect(calls).toBe(2); // the verdict is exactly two reads, never one or three
  });
  it("a size that moved between probes is not quiet", async () => {
    let size = 10;
    const read: LogWindowReader = async () => {
      size += 5;
      return { bytes: new Uint8Array(0), next: 0, size };
    };
    expect((await probeQuiet(read, sleepNoop)).quiet).toBe(false);
  });
});

describe("waitSentinel", () => {
  it("finds the sentinel whole in one window and lands nextByte right after its newline", async () => {
    const log = enc.encode(`out line\n__xcomm_w1_DONE rc=0\n$ `);
    const r = await waitSentinel(readerOver(log), "w1", 0, {
      timeoutMs: 5_000,
      sleep: sleepNoop,
      now: () => 0,
    });
    expect(r.status).toBe("completed");
    expect(r.rc).toBe(0);
    expect(r.outputLines).toEqual(["out line"]);
    // nextByte: right after the sentinel's own newline, NOT the window end;
    // the "$ " after it must still be pending for the follow-up read.
    expect(log.subarray(r.nextByte)).toEqual(enc.encode("$ "));
  });

  it("finds the sentinel split across two reads (the liveness-rule case)", async () => {
    const log = enc.encode(`work\n__xcomm_w2_DON` + `E rc=7\nrest`);
    const r = await waitSentinel(readerOver(log, 13), "w2", 0, {
      timeoutMs: 20_000,
      ...clock,
    });
    expect(r).toMatchObject({ status: "completed", rc: 7, outputLines: ["work"] });
    expect(log.subarray(r.nextByte)).toEqual(enc.encode("rest"));
  });

  it("an unfound sentinel reports timed_out with everything seen and nothing touched", async () => {
    const log = enc.encode("still going\nstill going\n");
    let now = 0;
    const r = await waitSentinel(readerOver(log, 16), "w3", 0, {
      timeoutMs: 100,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(r.status).toBe("timed_out");
    expect(r.rc).toBeNull();
    expect(r.outputLines.join("")).toContain("still going");
  });

  it("a timed-out wait reports the carried partial line (the bytes the cursor already advanced past)", async () => {
    // Data honesty (Task 1 review): the liveness branch moves `nextByte` PAST
    // an unterminated tail, so a follow-up cursor read never returns those
    // bytes: if the timed-out answer dropped the scanner's carry, that text
    // would reach no one. The completed path is untouched: a hit proves the
    // sentinel line was newline-terminated in-window, so nothing is carried.
    const log = enc.encode("done line\npartial");
    let now = 0;
    const r = await waitSentinel(readerOver(log, 12), "w5", 0, {
      timeoutMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(r.status).toBe("timed_out");
    expect(r.outputLines).toEqual(["done line", "partial"]);
  });

  it("a pane that died mid-wait ends the wait immediately", async () => {
    let now = 0;
    const read = readerOver(enc.encode("x\n".repeat(500)), 8);
    const r = await waitSentinel(read, "w4", 0, {
      timeoutMs: 100_000,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      alive: async () => now < 1_000, // dies at the second poll
    });
    expect(r.status).toBe("timed_out");
    expect(now).toBeLessThan(2_000); // did not run out the 100 s timeout
  });
});

describe("execOutputTail", () => {
  it("keeps whole lines from the newest backwards inside the cap", () => {
    const lines = ["a".repeat(100), "b".repeat(100), "c"];
    const r = execOutputTail(lines, 105);
    expect(r.text).toBe(`${"b".repeat(100)}\nc`);
    expect(r.truncated).toBe(true);
  });
  it("under the cap: everything, not truncated", () => {
    const r = execOutputTail(["one", "two"], EXEC_MAX_OUTPUT_BYTES);
    expect(r).toEqual({ text: "one\ntwo", truncated: false });
  });
});
