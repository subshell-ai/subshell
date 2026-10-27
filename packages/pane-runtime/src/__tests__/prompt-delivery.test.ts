import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { deliverPromptInto, type PromptDeliveryPane, submitPaneInput } from "../prompt-delivery.js";
import { freshSocket, runner } from "./helpers/tmux-test-harness.js";

/**
 * The shared create/restart prompt-delivery policy. The bug this suite pins:
 * Claude Code renders its UI seconds before its stdin reader mounts, and bytes
 * typed in that window are consumed as ONE bulk chunk on mount, which the
 * harness eats as a paste — the trailing Enter is swallowed and the prompt
 * sits in the input box unsubmitted. Enter therefore may only be pressed once
 * the typed text is visible in the pane (proof the harness is reading and
 * rendering its input), and the delivery must fall back to the old blind
 * behavior when that never happens within the budget.
 */

interface FakeCall {
  kind: "capture" | "sendInput" | "pressEnter";
  detail?: string;
}

/**
 * A `PromptDeliveryPane` whose captures come from a script (last entry
 * repeats when the script runs dry) and whose calls are all recorded, so a
 * test can assert not just outcomes but the ORDER: no Enter before the screen
 * shows the typed text.
 */
function fakePane(captures: string[]) {
  const calls: FakeCall[] = [];
  let reads = 0;
  const pane: PromptDeliveryPane = {
    async capturePane() {
      const cap = captures[Math.min(reads, captures.length - 1)];
      reads += 1;
      calls.push({ kind: "capture", detail: cap });
      return cap;
    },
    async sendInput(_socket, _id, input) {
      calls.push({ kind: "sendInput", detail: input });
    },
    async pressEnter() {
      calls.push({ kind: "pressEnter" });
    },
  };
  return { pane, calls };
}

/** A clock that advances `step` ms on every read, so deadline math is owned. */
function steppingClock(step: number): () => number {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

describe("deliverPrompt (shared policy)", () => {
  it("presses Enter only once the pane shows the typed text", async () => {
    // A pane that boots blank, then shows a banner the instant input lands
    // (echo), i.e. the text appears only in the gate's captures.
    const { pane, calls } = fakePane(["", "banner", "banner", "banner\n❯ hello there"]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "hello there", {
      settleTimeoutMs: 10_000,
      pollMs: 1,
      nowMs: steppingClock(1),
    });
    expect(delivered).toBe(true);
    const kinds = calls.map((c) => c.kind);
    const inputAt = kinds.indexOf("sendInput");
    const enterAt = kinds.indexOf("pressEnter");
    expect(inputAt).toBeGreaterThan(-1);
    expect(enterAt).toBeGreaterThan(inputAt);
    // Every capture between input and Enter still lacked the text on the
    // first one (the gate waited), and the last one had it.
    const between = calls.slice(inputAt + 1, enterAt);
    expect(between.length).toBeGreaterThanOrEqual(1);
    expect(between[between.length - 1]?.detail).toContain("hello there");
    expect(between[0]?.detail).not.toContain("hello there");
  });

  it("a prompt whose newlines the pane swallows still clears the gate", async () => {
    // Claude Code eats raw LFs from the burst: the rendered box shows the
    // text run together. Matching normalizes whitespace on both sides.
    const { pane, calls } = fakePane(["", "ready", "ready: first line second line"]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "first line\n\nsecond line", {
      settleTimeoutMs: 10_000,
      pollMs: 1,
      nowMs: steppingClock(1),
    });
    expect(delivered).toBe(true);
    expect(calls.some((c) => c.kind === "pressEnter")).toBe(true);
  });

  it("ANSI-wrapped text in the capture still clears the gate", async () => {
    const { pane } = fakePane(["", "boot", "boot\n❯ \x1b[38;5;114mhello\x1b[39m \x1b[1mthere\x1b[0m"]);
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hello there", {
        settleTimeoutMs: 10_000,
        pollMs: 1,
        nowMs: steppingClock(1),
      }),
    ).toBe(true);
  });

  it("gate timeout never blocks delivery: Enter still runs, budget-exhausted still true", async () => {
    // The harness never echoes the text (masked input, an invisible dialog):
    // the gate waits its OWN budget and Enter goes anyway — today's behavior.
    const { pane, calls } = fakePane(["", "banner"]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "secret prompt", {
      settleTimeoutMs: 100,
      renderTimeoutMs: 100,
      pollMs: 1,
      nowMs: steppingClock(10),
    });
    expect(delivered).toBe(true);
    expect(calls.some((c) => c.kind === "pressEnter")).toBe(true);
  });

  it("a banner a short prompt hides inside is no proof until an occurrence is added", async () => {
    // "hi" sits inside "This is…" from the very first painted frame, so its
    // bare presence proves nothing. The gate must hold Enter through the
    // captures whose needle count matches the baseline and release only once
    // the pane's own echo adds one.
    const banner = "This is the boot banner";
    const { pane, calls } = fakePane(["", banner, banner, `${banner}\n❯ hi`]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "hi", {
      settleTimeoutMs: 10_000,
      renderTimeoutMs: 10_000,
      pollMs: 1,
      nowMs: steppingClock(1),
    });
    expect(delivered).toBe(true);
    const kinds = calls.map((c) => c.kind);
    const inputAt = kinds.indexOf("sendInput");
    const enterAt = kinds.indexOf("pressEnter");
    const gate = calls.slice(inputAt + 1, enterAt);
    expect(gate.length).toBeGreaterThanOrEqual(2); // baseline repeat rejected…
    expect(gate[0]?.detail).toBe(banner); // …then the echo accepted
    expect(gate[gate.length - 1]?.detail).toContain("❯ hi");
  });

  it("text already on a static screen burns the gate budget, Enter still goes", async () => {
    // A resumed transcript that already shows the prompt: no NEW occurrence
    // ever appears, so the gate times out rather than fast-forwarding Enter
    // into the mount window.
    const { pane, calls } = fakePane(["", "welcome hi panel"]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "hi", {
      settleTimeoutMs: 100,
      renderTimeoutMs: 100,
      pollMs: 1,
      nowMs: steppingClock(10),
    });
    expect(delivered).toBe(true);
    expect(calls.filter((c) => c.kind === "capture").length).toBeGreaterThan(3);
    expect(calls.some((c) => c.kind === "pressEnter")).toBe(true);
  });

  it("spinner repaints next to a needle-bearing banner hold the gate; the echo releases it", async () => {
    // The shape the count rule exists for: the banner already contains "hi",
    // the pane ANIMATES (spinner glyph swaps every frame, screen changes each
    // poll), and only the harness's own echo adds an occurrence. A rule
    // trusting screen-change would fire Enter on the first spinner tick,
    // reader still unmounted.
    const b = "This is the boot banner";
    const { pane, calls } = fakePane([
      "",
      `${b} ✋`,
      `${b} ✊`, // animated repaint: screen differs from baseline, count does not
      `${b} ✋`,
      `${b} ✋\n❯ hi`, // the echo: a second "hi" appears
    ]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", "hi", {
      settleTimeoutMs: 10_000,
      renderTimeoutMs: 10_000,
      pollMs: 1,
      nowMs: steppingClock(1),
    });
    expect(delivered).toBe(true);
    const kinds = calls.map((c) => c.kind);
    const enterAt = kinds.indexOf("pressEnter");
    expect(enterAt).toBe(kinds.length - 1); // released by the echo, not a spinner tick
    expect(calls.filter((c) => c.kind === "capture").length).toBe(5);
  });

  it("pressEnter failure ⇒ false", async () => {
    // New split from the old single try: failing AFTER the gate (possibly a
    // whole budget later) is its own false path.
    const pane: PromptDeliveryPane = {
      async capturePane() {
        return "ready";
      },
      async sendInput() {},
      async pressEnter() {
        throw new Error("no pane");
      },
    };
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hi", {
        settleTimeoutMs: 100,
        renderTimeoutMs: 100,
        pollMs: 1,
        nowMs: steppingClock(10),
      }),
    ).toBe(false);
  });

  it("waits for the end of a long prompt instead of submitting its partial render", async () => {
    const text = `${"x".repeat(60)} ${"y".repeat(60)}`;
    const { pane, calls } = fakePane(["boot", `❯ ${"x".repeat(60)}`, "y".repeat(60)]);
    const delivered = await deliverPromptInto(pane, "sock", "s1", text, {
      settleTimeoutMs: 10_000,
      pollMs: 1,
      nowMs: steppingClock(1),
    });
    expect(delivered).toBe(true);
    expect(calls.filter((call) => call.kind === "capture").map((call) => call.detail)).toEqual([
      "boot",
      `❯ ${"x".repeat(60)}`,
      "y".repeat(60),
    ]);
    expect(calls.at(-1)?.kind).toBe("pressEnter");
  });

  it("submits from a blank running pane after its paste parser has had time to settle", async () => {
    let renderedAt = 0;
    let submitted = false;
    let typed = false;
    const pane: PromptDeliveryPane = {
      async capturePane() {
        if (!typed) return "";
        renderedAt = Date.now();
        return "❯ pasted prompt";
      },
      async sendInput() {
        typed = true;
      },
      async pressEnter() {
        // A TUI can still treat Enter as pasted text just after rendering.
        submitted = Date.now() - renderedAt >= 150;
      },
    };
    await submitPaneInput(pane, "sock", "s1", "pasted prompt", { pollMs: 1 });
    expect(submitted).toBe(true);
  });

  it("never settles ⇒ false, no input, no Enter", async () => {
    const { pane, calls } = fakePane([""]);
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hi", {
        settleTimeoutMs: 100,
        pollMs: 1,
        nowMs: steppingClock(10),
      }),
    ).toBe(false);
    // The settle loop polls captures; it must not reach the input trio.
    expect(calls.every((c) => c.kind === "capture")).toBe(true);
  });

  it("ANSI control codes alone never settle ⇒ false, nothing typed", async () => {
    // A screen holding only a clear/reset sequence is blank, not booted: the
    // node executor's rule (the old waitForSettled stripped ANSI before the
    // blank check) now lives in the shared policy.
    const { pane, calls } = fakePane(["\x1b[2J\x1b[H"]);
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hi", {
        settleTimeoutMs: 100,
        pollMs: 1,
        nowMs: steppingClock(10),
      }),
    ).toBe(false);
    expect(calls.every((c) => c.kind === "capture")).toBe(true);
  });

  it("sendInput failure ⇒ false, Enter never runs", async () => {
    const calls: FakeCall[] = [];
    const pane: PromptDeliveryPane = {
      async capturePane() {
        return "ready";
      },
      async sendInput() {
        throw new Error("no pane");
      },
      async pressEnter() {
        calls.push({ kind: "pressEnter" });
      },
    };
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hi", {
        settleTimeoutMs: 100,
        pollMs: 1,
        nowMs: steppingClock(10),
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("capture errors during the gate are swallowed and polling continues", async () => {
    // The gate reaches the throwing capture (error ⇒ miss), then the text
    // shows and Enter goes.
    let reads = 0;
    const pane: PromptDeliveryPane = {
      async capturePane() {
        reads += 1;
        if (reads === 1) return "ready";
        if (reads === 2) throw new Error("can't find pane");
        return "ready ❯ hi";
      },
      async sendInput() {},
      async pressEnter() {},
    };
    expect(
      await deliverPromptInto(pane, "sock", "s1", "hi", {
        settleTimeoutMs: 10_000,
        pollMs: 1,
        nowMs: steppingClock(1),
      }),
    ).toBe(true);
  });
});

describe("deliverPrompt (real pane, booting TUI that eats a bulk-read Enter)", () => {
  it("submits into a harness whose mount-time read swallows a queued Enter", async () => {
    // Mirrors the measured Claude Code shape: the UI paints first, the stdin
    // reader mounts ~1s later, and the first chunk it reads is treated as a
    // paste — every CR in it is stripped (the prompt lands, no submit). Only
    // a LATER chunk carrying Enter submits. Delivering blindly (type, then
    // Enter, before mount) queues both bytes into that first chunk and the
    // prompt sits there unsubmitted forever.
    const socket = freshSocket("pdelay");
    const script = `/tmp/subshell-pdelay-${process.pid}-${Date.now()}.ts`;
    await Bun.write(
      script,
      `
      // Render the "UI" at once, then stop reading (and stop the tty echo via
      // raw mode) for a beat: anything typed before mount piles up in the pty.
      process.stdout.write("BOOT\\n> ");
      process.stdin.setRawMode(true);
      let firstRead = true;
      const timer = setTimeout(() => {
        process.stdin.resume();
        process.stdin.on("data", (chunk: Buffer) => {
          const s = chunk.toString("utf8");
          if (firstRead) {
            // The bulk read is "a paste": render the text, drop the CRs.
            firstRead = false;
            process.stdout.write(s.replaceAll("\\r", ""));
            return;
          }
          if (s.includes("\\r")) {
            process.stdout.write("\\nSUBMITTED\\n");
            process.exit(0);
          }
          process.stdout.write(s);
        });
      }, 1200);
      timer.unref();
      setInterval(() => {}, 1000);
    `,
    );
    runner.newSubshell(socket, "s1", "/tmp", `exec bun ${script}`);
    try {
      const delivered = await deliverPromptInto(runner, socket, "s1", "please say hello", {
        settleTimeoutMs: 10_000,
        pollMs: 50,
      });
      expect(delivered).toBe(true);
      // The proof of submission is the program's own line — only an Enter it
      // accepted as its own chunk gets there.
      const deadline = Date.now() + 10_000;
      let screen = "";
      while (Date.now() < deadline) {
        screen = await runner.capturePane(socket, "s1");
        if (screen.includes("SUBMITTED")) break;
        await Bun.sleep(100);
      }
      expect(screen).toContain("SUBMITTED");
    } finally {
      runner.killSubshell(socket, "s1");
      void runner.cleanSocket(socket);
      try {
        unlinkSync(script);
      } catch {
        // already gone; nothing to reap
      }
    }
  }, 30_000);
});
