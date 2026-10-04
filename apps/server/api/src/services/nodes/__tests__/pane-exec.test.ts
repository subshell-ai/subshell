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
    const s = createSentinelScanner("0000000000000000");
    expect(s.push(["working dir ok", "build started"], false)).toBeNull();
    const hit = s.push(["__xcomm_0000000000000000_DONE rc=0"], false);
    expect(hit).toEqual({ rc: 0, hitInWindow: 0 });
    expect(s.output()).toEqual(["working dir ok", "build started"]);
  });

  it("the typed echo never matches (it carries quotes and a literal $?)", () => {
    const s = createSentinelScanner("1111111111111111");
    const echo = `$ printf '__xcomm_1111111111111111_DONE rc=%s\\n' "$?"`;
    expect(s.push([echo], false)).toBeNull();
  });

  it("a fish-shaped empty rc never matches and the stream keeps accumulating", () => {
    const s = createSentinelScanner("2222222222222222");
    expect(s.push(["__xcomm_2222222222222222_DONE rc="], false)).toBeNull();
    expect(s.output()).toEqual(["__xcomm_2222222222222222_DONE rc="]); // ordinary text, not a hit, not lost
  });

  it("a partial tail line is carried, matched when completed by the next window", () => {
    const s = createSentinelScanner("3333333333333333");
    expect(s.push(["noise"], false)).toBeNull();
    expect(s.push(["__xcomm_3333333333333333_DO"], true)).toBeNull(); // split read 1: NO match, held
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
    const log = enc.encode(`out line\n__xcomm_a1a1a1a1a1a1a1a1_DONE rc=0\n$ `);
    const r = await waitSentinel(readerOver(log), "a1a1a1a1a1a1a1a1", 0, {
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
    // Window 20 with the full-width hex token reproduces the same split the
    // short one used to land in: read 1 ends inside the token with no newline.
    const log = enc.encode(`work\n__xcomm_a2a2a2a2a2a2a2a2_DON` + `E rc=7\nrest`);
    const r = await waitSentinel(readerOver(log, 20), "a2a2a2a2a2a2a2a2", 0, {
      timeoutMs: 20_000,
      ...clock,
    });
    expect(r).toMatchObject({ status: "completed", rc: 7, outputLines: ["work"] });
    expect(log.subarray(r.nextByte)).toEqual(enc.encode("rest"));
  });

  it("an unfound sentinel reports timed_out with everything seen and nothing touched", async () => {
    const log = enc.encode("still going\nstill going\n");
    let now = 0;
    const r = await waitSentinel(readerOver(log, 16), "a3a3a3a3a3a3a3a3", 0, {
      timeoutMs: 100,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(r.status).toBe("timed_out");
    expect(r.rc).toBeNull();
    expect(r.outputLines.join("")).toContain("still going");
    // The scan stopped where it consumed: the two 12-byte lines each land
    // whole inside a 16-byte window, so both windows run the cursor to the
    // line boundary (12, then the 24-byte end of the log) before the deadline
    // check ends the wait. A follow-up reader must resume at 24, never resee
    // the carried text or skip past unscanned bytes.
    expect(r.nextByte).toBe(24);
  });

  it("a timed-out wait reports the carried partial line (the bytes the cursor already advanced past)", async () => {
    // Data honesty (Task 1 review): the liveness branch moves `nextByte` PAST
    // an unterminated tail, so a follow-up cursor read never returns those
    // bytes: if the timed-out answer dropped the scanner's carry, that text
    // would reach no one. The completed path is untouched: a hit proves the
    // sentinel line was newline-terminated in-window, so nothing is carried.
    const log = enc.encode("done line\npartial");
    let now = 0;
    const r = await waitSentinel(readerOver(log, 12), "a5a5a5a5a5a5a5a5", 0, {
      timeoutMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(r.status).toBe("timed_out");
    expect(r.outputLines).toEqual(["done line", "partial"]);
  });

  it("a rejected read mid-wait is 'no data this poll', not a thrown failure", async () => {
    // PR #319 review: after the typing, one transport blip must not cost the
    // caller the receipt. The first read rejects, the second answers the
    // sentinel, and the wait still COMPLETES with the right cursor; a reader
    // that always rejects ends at the deadline with the accumulated output
    // intact, because a merely slow link and a lost command are the same
    // observed shape and only the deadline distinguishes them honestly.
    const log = enc.encode("working\n__xcomm_a6a6a6a6a6a6a6a6_DONE rc=4\n");
    let failed = false;
    const flaky: LogWindowReader = async (fromByte, maxBytes) => {
      if (!failed) {
        failed = true;
        throw new Error("sim: link blip");
      }
      const end = Math.min(log.byteLength, fromByte + maxBytes);
      return { bytes: log.subarray(fromByte, end), next: end, size: log.byteLength };
    };
    const r = await waitSentinel(flaky, "a6a6a6a6a6a6a6a6", 0, {
      timeoutMs: 5_000,
      ...clock,
    });
    expect(r).toMatchObject({ status: "completed", rc: 4, outputLines: ["working"] });
    expect(r.nextByte).toBe(log.byteLength);
  });

  it("a reader that always rejects times out with nothing lost", async () => {
    let now = 0;
    const dead: LogWindowReader = async () => {
      throw new Error("sim: node gone quiet");
    };
    const r = await waitSentinel(dead, "a7a7a7a7a7a7a7a7", 42, {
      timeoutMs: 100,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(r).toMatchObject({ status: "timed_out", rc: null, outputLines: [] });
    expect(r.nextByte).toBe(42); // the cursor never moves on bytes it never read
  });

  it("a pane that died mid-wait ends the wait immediately", async () => {
    let now = 0;
    const read = readerOver(enc.encode("x\n".repeat(500)), 8);
    const r = await waitSentinel(read, "a4a4a4a4a4a4a4a4", 0, {
      timeoutMs: 100_000,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      alive: async () => now < 1_000, // dies at the second poll
    });
    expect(r.status).toBe("timed_out");
    expect(now).toBeLessThan(2_000); // did not run out the 100 s timeout
    // The death stops the wait BEFORE its read, not mid-window: the alive
    // check passed twice (now 0 and 500), each consuming one 8-byte window,
    // and the third check (now 1000) ended the wait with the cursor parked
    // after those two consumed windows.
    expect(r.nextByte).toBe(16);
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
  it("caps in UTF-8 BYTES, not code units (a CJK line costs 3, an emoji up to 4)", () => {
    // Each line is 3 characters: 3 UTF-16 code units, but "é" is 2 bytes and
    // "😀" is 4, so the joined text is 2(2+1)+... measured honestly below.
    const line = "é😀a"; // 2 + 4 + 1 = 7 bytes
    expect(execOutputTail([line], 7)).toEqual({ text: line, truncated: false }); // 7 bytes, the closing newline uncounted
    expect(execOutputTail([line, line], 15)).toEqual({ text: `${line}\n${line}`, truncated: false }); // 7+1+7 = exactly 15
    expect(execOutputTail([line, line], 14)).toEqual({ text: line, truncated: true }); // 14 does not: newest kept
    // A `.length` count (3 per line) would have called 3+1+3 = 7 under a cap of 7
    // and never truncated; the byte count is what the name and docs promise.
  });
  it("one line bigger than the cap yields an empty tail, honestly named", () => {
    // Whole-line discipline: mid-character cutting is a worse promise than an
    // empty answer with truncated: true (the reader can re-read via nextByte).
    const big = "x".repeat(200);
    expect(execOutputTail([big], 100)).toEqual({ text: "", truncated: true });
  });
});
