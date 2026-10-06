import { describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { getRequestlessContext } from "@/lib/context.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { cleanupSubshellWs, handleSubshellMessage } from "@/ws/subshell-ws.js";
import { sharedGridFor } from "@/ws/viewers.js";
import {
  attach,
  captureCalls,
  defaultLocalLauncher,
  order,
  resizeCalls,
  seedLocalRow,
  stubLauncher,
} from "./helpers/local-attach-harness.js";

describe("local attach cleanup — the ws.data wiring (pre-existing leak)", () => {
  it("skips the winch storm for a RESTARTED row inside its boot grace (residual log + fresh startedAt)", async () => {
    // The local twin of the relay's wiring pins. `paneReadsAsBooting` is
    // unit-pure and pinned there; THIS case pins that the local attach
    // actually passes `row.startedAt` to it — drop the argument and every
    // other suite stays green while a second boot takes the storm again.
    // A restart reuses the row and the log survives on purpose, so the
    // residual 4 bytes plus a fresh boot timestamp must read as booting:
    // exactly ONE resize (the fit), no winch, no ±1 step.
    stubLauncher();
    let paneRows = 52; // differs from the join size, so the fit resize really fires
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    // No SIGWINCH route: settled here means the ±1 nudge below the winch
    // attempt — the very provocation this fast path exists to skip. The push
    // keeps "did the storm even start" observable.
    defaultLocalLauncher.signalPaneWinch = async () => {
      order.push("winch");
      return false;
    };
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");
    const { repos } = getRequestlessContext();
    await repos.subshells.update(row.id, { startedAt: new Date().toISOString() });

    const _viewer = await attach(row.userId, row.id, "&cols=100&rows=50");

    expect(resizeCalls).toEqual([{ cols: 100, rows: 50 }]);
    expect(order).not.toContain("winch");
  });

  it("ends the replay on the PANE's cursor — the restore every live byte leans on", async () => {
    // Without it the client's cursor sits after the replay's last row (the
    // bottom of the grid) while a fresh shell's cursor is under its prompt
    // near the TOP — 16 rows apart on an 18-row pane, so every echo painted
    // at the bottom and the operator had to scroll up to type (2026-09-23
    // browser report). The relay twin lives in remote-subshell-ws.test.ts;
    // this pins the local attach actually READS `paneCursor` and hands it to
    // the replay builder.
    stubLauncher();
    defaultLocalLauncher.paneCursor = async () => ({ x: 4, y: 2 });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const viewer = await attach(row.userId, row.id);

    // tmux cursor coords are 0-based, CUP is 1-based: (4,2) -> ESC[3;5H.
    const replay = JSON.parse(viewer.sent[0]) as { type: string; data: string };
    expect(replay.type).toBe("replay");
    expect(replay.data.endsWith("SCREEN\x1b[3;5H")).toBe(true);
  });

  it("ships the replay WITHOUT a cursor restore when the cursor cannot be read", async () => {
    // Null is the degraded path, never a guess: a wrong CUP strands every
    // later byte worse than no CUP.
    stubLauncher(); // default: paneCursor -> null
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const viewer = await attach(row.userId, row.id);

    const replay = JSON.parse(viewer.sent[0]) as { type: string; data: string };
    expect(replay.data).toBe("SCREEN");

    cleanupSubshellWs(viewer.ws);
  });

  it("clears a pin when the device it names leaves", async () => {
    // `decideSharedGrid` already falls through to auto for a pin it cannot
    // resolve, so the pane is never wrong — but the policy still rides the
    // presence frame, and the UI faithfully reported "pinned" plus a "Back to
    // automatic" for a pin that had not been in effect since that tab closed.
    // A control that lies about the state it controls is worse than none.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    const laptopId = (
      JSON.parse(laptop.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
        you: string;
      }
    ).you;

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: laptopId }));
    await Bun.sleep(60);
    const pinned = JSON.parse(phone.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
      sizing: { mode: string; pinnedViewerId: string | null };
    };
    expect(pinned.sizing).toEqual({ mode: "pinned", pinnedViewerId: laptopId });

    cleanupSubshellWs(laptop.ws); // the pinned device closes its tab
    await Bun.sleep(60);

    const after = JSON.parse(phone.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
      sizing: { mode: string; pinnedViewerId: string | null };
    };
    expect(after.sizing).toEqual({ mode: "auto", pinnedViewerId: null });

    cleanupSubshellWs(phone.ws);
  });

  it("re-decides the grid once the attach is over, so a raced resize is not lost", async () => {
    // The attach resizes the pane DIRECTLY (it must be awaited before the
    // capture) and seeds the queue behind its back, so it can interleave with
    // a concurrent `requestPaneResize` from another viewer: the queue applies
    // the newer shared grid and records it, this attach's seed overwrites the
    // record, and the repaint nudge returns the pane to the attach's own fit.
    // The pane is then left at a size the viewer set does not call for, with
    // nothing scheduled to notice.
    //
    // Driven here through the front door: a second viewer whose capacity the
    // attach could not have seen, applied while the attach is still running.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=100&rows=50");
    // A second viewer that can only show 30 rows. Whatever order the attach
    // and this frame interleave in, the pane must END at the shared minimum.
    const second = await attach(row.userId, row.id, "&cols=100&rows=30");
    handleSubshellMessage(second.ws, JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await Bun.sleep(80);

    expect(sharedGridFor(row.id)).toEqual({ cols: 100, rows: 30 });
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 30 });

    cleanupSubshellWs(second.ws);
    cleanupSubshellWs(first.ws);
  });

  it("honours `&hidden=1` from the connect URL, without waiting for a frame", async () => {
    // The client's on-open `visibility` frame races this handler's own awaits
    // and is DROPPED when it wins (`handleSubshellMessage` returns while
    // `ws.data` is still empty). Capacity survives that race because it is
    // re-sent on every resize; `visibility` is sent once and then only on
    // change, so a tab attached while already hidden would have held every
    // other device's pane at its size for the socket's whole life.
    stubLauncher();
    let paneRows = 60; // differs from both viewers, so the laptop's fit RESIZES —
    // otherwise a silent no-op would pass "takes no part" for the wrong reason.
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const resizedByLaptop = resizeCalls.length;
    const pocketed = await attach(row.userId, row.id, "&cols=100&rows=20&hidden=1");

    // The hidden joiner takes no part: the pane stays at the laptop's size.
    // The view is sliced to THIS join - the shared recorder can carry
    // legitimate resizes from earlier cases (and earlier files), and the
    // claim is about the join that follows the laptop's attach.
    const joinResizes = resizeCalls.slice(resizedByLaptop);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 });
    expect(joinResizes.some((c) => c.rows === 20)).toBe(false);
    expect(joinResizes.length).toBe(0);
    const presence = laptop.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: Array<{ hidden: boolean; capacity: { rows: number } | null }> })
      .at(-1);
    expect(presence?.viewers.find((v) => v.capacity?.rows === 20)?.hidden).toBe(true);

    cleanupSubshellWs(pocketed.ws);
    cleanupSubshellWs(laptop.ws);
  });

  it("tells the INCUMBENT when a smaller joiner shrinks the pane under it", async () => {
    // Found by driving two real browser tabs. The pane correctly took the
    // minimum, and the joiner rendered it — but the incumbent was never told,
    // so it kept painting the taller grid it had arrived with. A client and a
    // pane that disagree by even one row is the whole reason this work exists.
    //
    // The attach applies the shared fit DIRECTLY (it must be awaited before
    // the capture) rather than through the geometry queue, so the queue's own
    // announcement does not cover this path.
    stubLauncher();
    let paneRows = 52;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      order.push("resize");
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 122, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const incumbent = await attach(row.userId, row.id, "&cols=122&rows=52");
    const geometryIn = (frames: string[]) =>
      frames
        .filter((f) => f.includes('"type":"geometry"'))
        .map((f) => {
          const { cols, rows } = JSON.parse(f) as { cols: number; rows: number };
          return { cols, rows };
        });
    expect(geometryIn(incumbent.sent).at(-1)).toEqual({ cols: 122, rows: 52 });

    // A shorter viewer joins: smallest-wins takes the pane to 49 rows.
    const joiner = await attach(row.userId, row.id, "&cols=122&rows=49");

    expect(geometryIn(joiner.sent).at(-1)).toEqual({ cols: 122, rows: 49 });
    // ...and the incumbent is TOLD, rather than left painting 52 rows.
    expect(geometryIn(incumbent.sent).at(-1)).toEqual({ cols: 122, rows: 49 });

    cleanupSubshellWs(incumbent.ws);
    cleanupSubshellWs(joiner.ws);
  });

  it("hands the pane back when the small viewer is HIDDEN, and takes it again when shown", async () => {
    // A backgrounded tab is not laid out at all, so it cannot re-fit — and
    // pinning everyone else's terminal to phone size with nothing on screen to
    // explain it is indistinguishable from a bug.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 });

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "visibility", hidden: true }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 }); // laptop gets it back

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "visibility", hidden: false }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 }); // and loses it again

    cleanupSubshellWs(laptop.ws);
    cleanupSubshellWs(phone.ws);
  });

  it("a pinned viewer decides the grid, and a `view` grantee cannot pin", async () => {
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 });

    // Pin the laptop: it decides alone, even though it is the larger.
    const laptopId = (laptop.ws.data as { viewerId: string }).viewerId;
    handleSubshellMessage(laptop.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: laptopId }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 });

    // The policy is announced, so a client can render which device is driving.
    const latest = phone.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { sizing: { mode: string; pinnedViewerId: string | null } })
      .at(-1);
    expect(latest?.sizing).toEqual({ mode: "pinned", pinnedViewerId: laptopId });

    // A read-only viewer cannot change what everyone sees.
    (phone.ws.data as { canInput: boolean }).canInput = false;
    const phoneId = (phone.ws.data as { viewerId: string }).viewerId;
    handleSubshellMessage(phone.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: phoneId }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 }); // unchanged

    cleanupSubshellWs(laptop.ws);
    cleanupSubshellWs(phone.ws);
  });

  it("tells every viewer who else is watching, and which entry is itself", async () => {
    // A pane has one grid and the SMALLEST viewer decides it, so "why is my
    // terminal this size?" is only answerable if a client can see the other
    // devices — and it can only answer "is that me?" with `you`.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=120&rows=40&device=Laptop");
    const second = await attach(row.userId, row.id, "&cols=80&rows=24&device=Phone");

    const presenceOf = (frames: string[]) =>
      frames
        .filter((f) => f.includes('"type":"viewers"'))
        .map((f) => JSON.parse(f) as { you: string; viewers: Array<{ id: string; label: string }> })
        .at(-1);

    const asSeenBySecond = presenceOf(second.sent);
    expect(asSeenBySecond?.viewers.map((v) => v.label).sort()).toEqual(["Laptop", "Phone"]);

    // The first viewer is TOLD about the joiner — presence is pushed, not polled.
    const asSeenByFirst = presenceOf(first.sent);
    expect(asSeenByFirst?.viewers.map((v) => v.label).sort()).toEqual(["Laptop", "Phone"]);

    // Each is pointed at its own entry, and they are different entries.
    const meForFirst = asSeenByFirst?.viewers.find((v) => v.id === asSeenByFirst.you);
    const meForSecond = asSeenBySecond?.viewers.find((v) => v.id === asSeenBySecond.you);
    expect(meForFirst?.label).toBe("Laptop");
    expect(meForSecond?.label).toBe("Phone");
    expect(asSeenByFirst?.you).not.toBe(asSeenBySecond?.you);

    cleanupSubshellWs(first.ws);
    cleanupSubshellWs(second.ws);
  });

  it("reports each viewer's capacity, which is what explains the shared grid", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=120&rows=40&device=Laptop");
    const second = await attach(row.userId, row.id, "&cols=80&rows=24&device=Phone");

    const latest = second.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map(
        (f) => JSON.parse(f) as { viewers: Array<{ label: string; capacity: { cols: number; rows: number } | null }> },
      )
      .at(-1);
    const byLabel = Object.fromEntries((latest?.viewers ?? []).map((v) => [v.label, v.capacity]));
    expect(byLabel.Laptop).toEqual({ cols: 120, rows: 40 });
    expect(byLabel.Phone).toEqual({ cols: 80, rows: 24 });
    // ...and the pane took the smaller of them.
    expect(resizeCalls.at(-1)).toEqual({ cols: 80, rows: 24 });

    cleanupSubshellWs(first.ws);
    cleanupSubshellWs(second.ws);
  });

  it("normalizes a hand-built device label rather than trusting it", async () => {
    // The label is rendered in another viewer's browser and written to a log
    // line; the client's own sanitizing protects nothing against a crafted
    // socket URL.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const viewer = await attach(row.userId, row.id, `&device=${encodeURIComponent("Evil\r\nX-Injected: 1")}`);
    const latest = viewer.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: Array<{ label: string }> })
      .at(-1);
    expect(latest?.viewers[0]?.label).toBe("Evil X-Injected: 1");

    cleanupSubshellWs(viewer.ws);
  });

  it("the last viewer leaving stops the stream; one remaining viewer keeps it", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const first = await attach(row.userId, row.id);
    const second = await attach(row.userId, row.id);
    await Bun.sleep(60);

    cleanupSubshellWs(first.ws); // one leaves
    const firstFrames = first.sent.length;
    appendFileSync(logFile, "still streaming\n");
    await Bun.sleep(1300);
    expect(first.sent.slice(firstFrames)).toEqual([]); // the one who left is silent
    expect(second.sent.some((f) => f.includes("still streaming"))).toBe(true); // the other is not

    cleanupSubshellWs(second.ws); // the last one leaves
    const secondFrames = second.sent.length;
    appendFileSync(logFile, "after everyone left\n");
    await Bun.sleep(1300);
    expect(second.sent.slice(secondFrames)).toEqual([]);
  });

  it("the pane-poll branch: cleanup clears the poll interval — no captures after disconnect", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    // No log file at subshellLogPath(row.id) ⇒ the handler takes startPanePoll.

    const { ws } = await attach(row.userId, row.id);
    try {
      expect(typeof (ws.data as { cleanup?: unknown }).cleanup).toBe("function");
      await Bun.sleep(700); // ≥ 2 ticks of the 300ms poller
      expect(captureCalls).toBeGreaterThan(1); // replay capture + poll ticks ran
      cleanupSubshellWs(ws);
      // Snapshot AFTER a short settle. Clearing the interval cannot recall a
      // tick that already fired and is awaiting its capture, so reading the
      // counter in the same breath as the disconnect races that in-flight
      // call and blames it on the interval. What must be true is that no
      // FURTHER ticks arrive, which the 700ms window below (>2 ticks) proves.
      await Bun.sleep(50);
      const capturesAtDisconnect = captureCalls;
      await Bun.sleep(700);
      // RED today: the interval never cleared — the poller captures the pane
      // forever after the browser left.
      expect(captureCalls).toBe(capturesAtDisconnect);
    } finally {
      cleanupSubshellWs(ws);
    }
  });
});
