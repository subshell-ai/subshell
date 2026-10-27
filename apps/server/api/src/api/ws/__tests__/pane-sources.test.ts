import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogTailSource, createPanePollSource, createRemoteTailSource } from "@/api/ws/pane-sources.js";
import type { NodeLauncher } from "@/modules/nodes/node-launcher.js";
import type { RemoteLauncher } from "@/modules/nodes/remote-launcher.js";

const scratch = mkdtempSync(join(tmpdir(), "pane-sources-"));
let seq = 0;
const freshLog = (contents: string): string => {
  seq += 1;
  const file = join(scratch, `log-${process.pid}-${seq}.txt`);
  writeFileSync(file, contents);
  return file;
};

/** Waits for `check`, or fails with what was actually collected. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("createLogTailSource", () => {
  it("emits only what was appended AFTER the start offset", async () => {
    const file = freshLog("HISTORY\r\n");
    const seen: string[] = [];
    // The attach samples the offset before the resize; history belongs to the
    // replay snapshot, not the stream.
    const stop = createLogTailSource({ logFile: file, fromByte: "HISTORY\r\n".length }).start((t) => seen.push(t));
    try {
      appendFileSync(file, "live\r\n");
      await waitFor(() => seen.join("").includes("live"), "the appended bytes");
      expect(seen.join("")).toBe("live\r\n");
      expect(seen.join("")).not.toContain("HISTORY");
    } finally {
      stop();
    }
  });

  it("ships bytes written between the offset and the attach (the deliberate overlap)", async () => {
    // A gap is unrecoverable for a diff-rendering TUI; an overlap heals.
    const file = freshLog("HISTORY\r\n");
    const seen: string[] = [];
    appendFileSync(file, "raced\r\n"); // arrived before anyone subscribed
    const stop = createLogTailSource({ logFile: file, fromByte: "HISTORY\r\n".length }).start((t) => seen.push(t));
    try {
      await waitFor(() => seen.join("").includes("raced"), "the raced bytes");
    } finally {
      stop();
    }
  });

  it("holds a multi-byte character split across two appends", async () => {
    // Stream-lived decoder state: a fresh decoder per read burns the split
    // bytes to U+FFFD, which is why the pump is shared rather than copied.
    const file = freshLog("");
    const seen: string[] = [];
    const stop = createLogTailSource({ logFile: file, fromByte: 0 }).start((t) => seen.push(t));
    try {
      const euro = Buffer.from("€", "utf8"); // 3 bytes
      appendFileSync(file, euro.subarray(0, 2));
      await Bun.sleep(150);
      appendFileSync(file, euro.subarray(2));
      await waitFor(() => seen.join("").includes("€"), "the reassembled character");
      expect(seen.join("")).not.toContain("�");
    } finally {
      stop();
    }
  });

  it("strips DEC 2026 sync markers, including one split across appends", async () => {
    const file = freshLog("");
    const seen: string[] = [];
    const stop = createLogTailSource({ logFile: file, fromByte: 0 }).start((t) => seen.push(t));
    try {
      appendFileSync(file, "\x1b[?2026h" + "painted");
      await waitFor(() => seen.join("").includes("painted"), "the painted text");
      expect(seen.join("")).toBe("painted");
    } finally {
      stop();
    }
  });

  it("calls the output heartbeat once per emitted chunk, never for empty reads", async () => {
    const file = freshLog("");
    const seen: string[] = [];
    let beats = 0;
    const stop = createLogTailSource({ logFile: file, fromByte: 0, onOutput: () => (beats += 1) }).start((t) =>
      seen.push(t),
    );
    try {
      appendFileSync(file, "\x1b[?2026h"); // a marker alone paints nothing
      await Bun.sleep(200);
      expect(beats).toBe(0);
      appendFileSync(file, "real\r\n");
      await waitFor(() => seen.join("").includes("real"), "the painted text");
      expect(beats).toBe(1);
    } finally {
      stop();
    }
  });

  it("emits nothing after the disposer runs", async () => {
    const file = freshLog("");
    const seen: string[] = [];
    const stop = createLogTailSource({ logFile: file, fromByte: 0 }).start((t) => seen.push(t));
    stop();
    appendFileSync(file, "after-stop\r\n");
    await Bun.sleep(TAIL_SETTLE_MS);
    expect(seen.join("")).not.toContain("after-stop");
  });

  it("survives a missing log file without throwing", async () => {
    const seen: string[] = [];
    const stop = createLogTailSource({ logFile: join(scratch, "does-not-exist"), fromByte: 0 }).start((t) =>
      seen.push(t),
    );
    await Bun.sleep(150);
    expect(seen).toEqual([]);
    stop();
  });
});

/** Comfortably past the 1s backstop, so "nothing arrived" is meaningful. */
const TAIL_SETTLE_MS = 1500;

describe("createLogTailSource latency (an EXTERNAL appender, as pipe-pane is)", () => {
  it("delivers promptly when the writer is another process", async () => {
    // Every other case in this file appends with `appendFileSync`, in THIS
    // process — and an in-process write is the one case `fs.watch` reports
    // reliably (measured on bun 1.4.2 / macOS: 7 events for 7 self-writes,
    // but 0-1 for an external appender). Production is always the external
    // case: tmux `pipe-pane` runs `sh -c 'cat >> log'`. So this is the shape
    // that decides what a person feels when they type, and the only shape
    // that can catch the delivery falling back on the poll behind the watch.
    //
    // At a 1000ms poll this measured 698ms per keystroke, every sample within
    // 2ms of the others — a fixed timer, not an event.
    const file = freshLog("");
    const seen: string[] = [];
    const appender = Bun.spawn({ cmd: ["sh", "-c", `cat >> '${file}'`], stdin: "pipe" });
    const stop = createLogTailSource({ logFile: file, fromByte: 0 }).start((t) => seen.push(t));
    try {
      await Bun.sleep(100); // let the appender and the watch settle
      const sentAt = Date.now();
      appender.stdin.write("typed\r\n");
      appender.stdin.flush();
      await waitFor(() => seen.join("").includes("typed"), "the externally appended bytes");
      expect(Date.now() - sentAt).toBeLessThan(400);
    } finally {
      stop();
      appender.kill();
    }
  });
});

describe("createPanePollSource", () => {
  /** A launcher whose capture returns whatever the test sets. */
  function fakeLauncher(): { launcher: NodeLauncher; screen: string; captures: number } {
    const state = { screen: "", captures: 0, launcher: {} as NodeLauncher };
    state.launcher = {
      capture: async () => {
        state.captures += 1;
        return state.screen;
      },
    } as unknown as NodeLauncher;
    return state as { launcher: NodeLauncher; screen: string; captures: number };
  }

  it("emits only what GREW since the last capture", async () => {
    const fake = fakeLauncher();
    const seen: string[] = [];
    fake.screen = "one";
    const stop = createPanePollSource({
      launcher: fake.launcher,
      socket: "sock",
      subshellId: "s1",
      onOutput: () => {},
    }).start((t) => seen.push(t));
    try {
      await waitFor(() => seen.join("").includes("one"), "the first screen");
      fake.screen = "onetwo";
      await waitFor(() => seen.join("").includes("two"), "the growth");
      // The delta only — re-sending the whole screen would double-paint it.
      expect(seen.join("")).toBe("onetwo");
    } finally {
      stop();
    }
  });

  it("re-sends the WHOLE screen when it did not merely grow (a repaint)", async () => {
    const fake = fakeLauncher();
    const seen: string[] = [];
    fake.screen = "abc";
    const stop = createPanePollSource({ launcher: fake.launcher, socket: "sock", subshellId: "s1" }).start((t) =>
      seen.push(t),
    );
    try {
      await waitFor(() => seen.length >= 1, "the first screen");
      fake.screen = "zzz"; // not a prefix extension
      await waitFor(() => seen.length >= 2, "the repaint");
      expect(seen[1]).toBe("zzz");
    } finally {
      stop();
    }
  });

  it("emits nothing while the screen is unchanged", async () => {
    const fake = fakeLauncher();
    const seen: string[] = [];
    fake.screen = "static";
    const stop = createPanePollSource({ launcher: fake.launcher, socket: "sock", subshellId: "s1" }).start((t) =>
      seen.push(t),
    );
    try {
      await waitFor(() => seen.length === 1, "the first screen");
      await Bun.sleep(700); // >2 poll ticks
      expect(seen.length).toBe(1);
      expect(fake.captures).toBeGreaterThan(1); // it really did keep polling
    } finally {
      stop();
    }
  });

  it("stops polling after the disposer runs", async () => {
    const fake = fakeLauncher();
    fake.screen = "x";
    const stop = createPanePollSource({ launcher: fake.launcher, socket: "sock", subshellId: "s1" }).start(() => {});
    await waitFor(() => fake.captures >= 1, "the first poll");
    stop();
    const atStop = fake.captures;
    await Bun.sleep(700);
    expect(fake.captures).toBe(atStop);
  });
});

/**
 * The remote tail is the shared pump for every viewer of a node pane, so a
 * source that goes silent without saying so freezes the pane for all of them
 * until the server restarts (the 2026-10-27 stuck-pane incident). These cases
 * pin the two ways it refuses to go silent: a refused `tail_start`, and a
 * watchdog that reads a growing log against a dead-silent relay.
 */
describe("createRemoteTailSource", () => {
  interface RemoteTailFake {
    launcher: RemoteLauncher;
    /** The agent's `tail_start` callback, so the test can deliver (or not). */
    deliveries: ((bytes: Uint8Array, next: number) => void)[];
    /** How many relay disposers ran. */
    relayDisposed: number;
    sizeCalls: number;
  }

  function remoteTailStub(opts: {
    /** Reject the tail_start round-trip (the agent's relay refused). */
    refuse?: string;
    /** What the size probe answers (the node's current EOF). */
    size: () => number;
  }): RemoteTailFake {
    const fake: RemoteTailFake = {
      deliveries: [],
      relayDisposed: 0,
      sizeCalls: 0,
      launcher: {} as RemoteLauncher,
    };
    fake.launcher = {
      tailStart: async (
        _id: string,
        _subId: string,
        _fromByte: number,
        onChunk: (bytes: Uint8Array, next: number) => void,
      ) => {
        if (opts.refuse) throw new Error(opts.refuse);
        fake.deliveries.push(onChunk);
        let disposedOnce = false; // the REAL launcher disposer is idempotent; mirror it
        return () => {
          if (disposedOnce) return;
          disposedOnce = true;
          fake.relayDisposed += 1;
        };
      },
      readLogSized: async () => {
        fake.sizeCalls += 1;
        const size = opts.size();
        return { bytes: new Uint8Array(0), next: size, size };
      },
    } as unknown as RemoteLauncher;
    return fake;
  }

  /** Fast watchdog so a stall verdict does not cost a test its patience. */
  const FAST = { stallCheckMs: 20, stallAfterMs: 60 };

  it("reports a refused tail_start instead of streaming silence", async () => {
    const fake = remoteTailStub({ refuse: "node refused", size: () => 500 });
    const seen: string[] = [];
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 400,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start((t) => seen.push(t));
    try {
      await waitFor(() => deaths.length > 0, "the refusal to be reported");
      expect(deaths).toHaveLength(1);
      expect(deaths[0]).toContain("tail_start refused");
      expect(deaths[0]).toContain("node refused");
      expect(seen).toEqual([]); // nothing painted, and nothing pretending to
    } finally {
      stop();
    }
  });

  it("reports a stall when the log grows and the relay delivers nothing", async () => {
    // The dead-pump shape from the field: the node keeps appending, the
    // plane-side relay hands over zero bytes. A quiet pane (next case) must
    // NOT read this way, which is why growth is part of the verdict.
    let size = 400;
    const fake = remoteTailStub({ size: () => size });
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 400,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start(() => {});
    try {
      await Bun.sleep(100); // several checks while size still equals the cursor
      expect(deaths).toEqual([]);
      size = 1200; // the pane starts printing; the dead pump says nothing
      await waitFor(() => deaths.length > 0, "the watchdog verdict");
      expect(deaths[0]).toContain("stalled");
      expect(deaths[0]).toContain("EOF 1200");
      expect(fake.relayDisposed).toBe(1); // the corpse is disposed, not nursed
    } finally {
      stop();
    }
  });

  it("leaves a quiet pane alone (no bytes, no verdict)", async () => {
    const fake = remoteTailStub({ size: () => 400 });
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 400,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start(() => {});
    try {
      await Bun.sleep(250); // many check intervals over the stall threshold
      expect(deaths).toEqual([]);
      expect(fake.sizeCalls).toBeGreaterThan(0); // the watchdog really was probing
    } finally {
      stop();
    }
  });

  it("keeps a delivering pump healthy", async () => {
    let size = 400;
    const fake = remoteTailStub({ size: () => size });
    const seen: string[] = [];
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 400,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start((t) => seen.push(t));
    try {
      await waitFor(() => fake.deliveries.length === 1, "the tail_start handshake");
      const onChunk = fake.deliveries[0];
      // Bytes arrive as the log grows: the cursor and the clock both stay
      // fresh, so no probe even runs.
      for (let at = 500; at <= 1500; at += 100) {
        size = at;
        onChunk(Buffer.from(`x${at}`), at);
        await Bun.sleep(30);
      }
      expect(deaths).toEqual([]);
      expect(seen.join("")).toContain("x1500");
    } finally {
      stop();
    }
  });

  it("treats a rewind (log smaller than the cursor) as a stall too", async () => {
    // The retention-sweep-then-relaunch shape: the log under the pump got
    // replaced, so `size > cursor` would wait forever for a byte that can
    // never arrive at that offset again.
    let size = 1000;
    const fake = remoteTailStub({ size: () => size });
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 0,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start(() => {});
    try {
      await waitFor(() => fake.deliveries.length === 1, "the tail_start handshake");
      fake.deliveries[0](Buffer.from("hello"), 1000); // cursor now at 1000
      size = 20; // the file was replaced under the pump
      await waitFor(() => deaths.length > 0, "the rewind verdict");
      expect(deaths[0]).toContain("stalled");
    } finally {
      stop();
    }
  });

  it("stops probing once the stream is disposed", async () => {
    // A quiet pane (size equals the cursor): the watchdog probes and waits
    // forever without a verdict. The claim is only that after dispose even
    // the probing stops.
    const fake = remoteTailStub({ size: () => 400 });
    const deaths: string[] = [];
    const stop = createRemoteTailSource({
      launcher: fake.launcher,
      subshellId: "s1",
      fromByte: 400,
      ...FAST,
      onDead: (why) => deaths.push(why),
    }).start(() => {});
    await waitFor(() => fake.sizeCalls >= 1, "a first probe");
    stop();
    const atStop = fake.sizeCalls;
    await Bun.sleep(200);
    expect(fake.sizeCalls).toBe(atStop); // no interval left to tick
    expect(deaths).toEqual([]); // and nothing left to report to
  });
});
