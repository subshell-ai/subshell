import { decodeFrame } from "@internal/subshell-protocol/wire";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, expectSubshellRunning, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * The negotiated CBOR attach, end to end in a real browser (spec 2026-09-21
 * Wave B): the attach URL asks for `enc=cbor`, every server frame arrives as
 * CBOR binary and decodes to the frame it always was, and a typed keystroke
 * rides out as CBOR and comes back acked. Liveness is proven through the
 * network truth (token 200, socket upgrade, no reconnecting pill, status
 * chip), never through terminal DOM text (see e2e/AGENTS.md).
 */

/** A raw recorded frame entry, exactly as the in-page store held it. */
interface RawFrame {
  url: string;
  data: string | Uint8Array;
  sent?: boolean;
}

/** Records EVERY frame of the subshell socket, raw, in either direction. */
async function armWsRecorder(page: Page) {
  await page.addInitScript(() => {
    const store: { url: string; data: string | ArrayBuffer | Uint8Array; sent?: boolean }[] = [];
    (window as any).__wsFrames = store;
    const Orig = window.WebSocket;
    class RecordingWebSocket extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url as string, protocols);
        if (String(url).includes("/ws?subshell=")) {
          this.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") store.push({ url: String(url), data: ev.data });
            // A copied Uint8Array, never the raw ArrayBuffer: Playwright's
            // evaluate boundary transfers typed arrays by value but empties
            // plain ArrayBuffers, so the store must hold the bytes, not the
            // buffer.
            else store.push({ url: String(url), data: new Uint8Array(ev.data as ArrayBuffer).slice() });
          });
          const origSend = this.send.bind(this);
          const wrapped: typeof this.send = (d) => {
            if (typeof d === "string") store.push({ url: String(url), data: `SENT ${d}` });
            else store.push({ url: String(url), data: d as Uint8Array, sent: true });
            origSend(d);
          };
          this.send = wrapped;
        }
      }
    }
    (window as any).WebSocket = RecordingWebSocket;
  });
}

/** Every recorded frame, decoded: CBOR bytes to objects, strings passed through. */
async function decodedFrames(page: Page): Promise<Array<Record<string, unknown>>> {
  const raw = (await page.evaluate(() => (window as any).__wsFrames)) as RawFrame[];
  return raw.map((f) =>
    typeof f.data === "string"
      ? ({ raw: f.data } as unknown as Record<string, unknown>)
      : (decodeFrame(f.data) as Record<string, unknown>),
  );
}

const SPAWN_TIMEOUT = 60_000;

test("a negotiated attach speaks CBOR both ways and the pane answers", async ({ browser }) => {
  test.setTimeout(180_000);
  const name = `probe-cbor-${test.info().retry}`;

  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: ADMIN_STATE });
  const p = await wide.newPage();
  await armWsRecorder(p);
  await p.goto("/new");
  await pickAgent(p.getByPlaceholder("Choose an agent"), "pi");
  await p.fill("#picker-working-dir", "/tmp");
  await dismissDirectoryPanel(p);

  const tokenRes = p.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = p.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await p.getByRole("button", { name: "Start subshell" }).click();
  await expect(p).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
  await renameSubshell(p, name);

  await tokenRes;
  const ws = await socket;
  // THE NEGOTIATION: the attach URL asked for the CBOR wire, and the server
  // took the connection rather than refusing the unknown param.
  expect(new URL(ws.url()).searchParams.get("enc")).toBe("cbor");

  // Liveness by network truth: the reconnecting pill renders only while the
  // socket is down, and the status chip carries the pane's own alive pair.
  await expect(p.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  await expectSubshellRunning(p, SPAWN_TIMEOUT);

  // Every server frame on this socket is CBOR binary and decodes to the
  // frame shape the JSON wire always carried. The replay is the guaranteed
  // first big frame (both attach paths send it before presence), and the
  // viewers frame beside it carries the inputAcks flag the queue engages on.
  await expect
    .poll(
      async () => {
        const frames = await decodedFrames(p);
        return {
          replay: frames.some((f) => f.type === "replay" && typeof f.data === "string"),
          viewersAcks: frames.some((f) => f.type === "viewers" && f.inputAcks === true),
        };
      },
      { timeout: SPAWN_TIMEOUT },
    )
    .toEqual({ replay: true, viewersAcks: true });

  // Input rides out as CBOR too. The queue is engaged (the viewers frame
  // above advertised inputAcks), so every input frame carries an id, and the
  // pane's write comes back as a CBOR ack for id 1: the full round trip on
  // the negotiated wire. The typed text is asserted as the id-ordered
  // concatenation, because the queue and the motion throttle are free to
  // split or coalesce the keystrokes into frames however they like.
  await p.locator(".xterm-helper-textarea").click();
  await p.keyboard.type("echo probe-cbor\r");
  await expect
    .poll(
      async () => {
        const frames = await decodedFrames(p);
        const inputs = frames.filter((f) => f.type === "input");
        return {
          typed: inputs.map((f) => String(f.data ?? "")).join(""),
          bare: inputs.filter((f) => typeof f.id !== "number").length,
          acks: frames.filter((f) => f.type === "ack").map((f) => f.id),
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      typed: expect.stringContaining("echo probe-cbor"),
      bare: 0,
      acks: expect.arrayContaining([1]),
    });

  // Cleanup: close the probe subshell (Close terminates before deleting).
  await p.goto("/");
  const actions = p.getByRole("button", { name: `Actions for ${name}` });
  await expect(actions).toBeVisible();
  await actions.click();
  await p.getByRole("menuitem", { name: "Close" }).click();
  await p.locator("[data-slot='dialog-content'] button", { hasText: /^Close$/ }).click();
  await wide.close();
});
