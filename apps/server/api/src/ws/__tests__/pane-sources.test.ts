import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { createLogTailSource, createPanePollSource } from "@/ws/pane-sources.js";

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
