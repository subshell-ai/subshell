import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * The attach-geometry + image-paste contract, end-to-end in a real browser
 * (guards the 2026-09-01 "unjumbles over 10s / PWA can't paste images" report):
 *   1. attach a live subshell at a wide viewport and paint a long line;
 *   2. reopen the SAME subshell at a narrow viewport: the WS URL must carry
 *      cols/rows AND the `replay` frame the server ships must contain no
 *      row wider than the client's cols (wider rows are the jumble — xterm
 *      re-wraps them over the grid, and nothing repaints until a resize);
 *   3. fire an image `paste` at the focused terminal: the app must claim it
 *      before xterm sees it, upload the file, and inject the returned path.
 */

interface Frame {
  url: string;
  data: string;
}

/** Wraps WebSocket so every text frame of the subshell socket is recorded. */
async function armWsRecorder(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const store: { url: string; data: string }[] = [];
    (window as any).__wsFrames = store;
    const Orig = window.WebSocket;
    class RecordingWebSocket extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url as string, protocols);
        if (String(url).includes("/ws?subshell=")) {
          this.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") store.push({ url: String(url), data: ev.data });
          });
          const origSend = this.send.bind(this);
          const wrapped: typeof this.send = (d) => {
            if (typeof d === "string") store.push({ url: String(url), data: `SENT ${d}` });
            origSend(d);
          };
          this.send = wrapped;
        }
      }
    }
    (window as any).WebSocket = RecordingWebSocket;
  });
}

async function subshellFrames(page: import("@playwright/test").Page): Promise<Frame[]> {
  return (await page.evaluate(() => (window as any).__wsFrames)) as Frame[];
}

/** Strip SGR/CSI/OSC so row widths reflect printable characters only.
 * (Built from char codes: regex literals with ESC control chars trip lint.) */
function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  return s
    .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, "g"), "")
    .replace(new RegExp(`${esc}\\][^${bel}]*${bel}`, "g"), "")
    .replace(new RegExp(`${esc}[()][A-Z0-9]`, "g"), "");
}

test("wide → narrow reopen paints within the client's cols; image paste uploads", async ({ browser }) => {
  test.setTimeout(180_000);
  const name = `probe-jumble-${test.info().retry}`;

  // ── 1. Wide attach: create the subshell at 1440px and paint a long line.
  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: ADMIN_STATE });
  const p1 = await wide.newPage();
  await armWsRecorder(p1);
  await p1.goto("/new");
  await p1.getByPlaceholder("Choose a profile").click();
  await p1.getByRole("option", { name: "Default (pi)" }).click();
  await p1.fill("#working-dir", "/tmp");
  await p1.fill("#name", name);
  await p1.keyboard.press("Escape");
  await p1.getByRole("button", { name: "Start subshell" }).click();
  await expect(p1).toHaveURL(/\/subshells\/.+/, { timeout: 60_000 });
  const subshellId = new URL(p1.url()).pathname.split("/").pop()!;

  await p1.waitForFunction(
    () => ((window as any).__wsFrames ?? []).some((f: Frame) => f.data.includes('"replay"')),
    undefined,
    { timeout: 60_000 },
  );
  const wideUrl = (await subshellFrames(p1))[0].url;
  expect(new URL(wideUrl).searchParams.get("cols")).toBeTruthy();

  await p1.locator(".xterm-helper-textarea").click();
  await p1.keyboard.insertText("A".repeat(240)); // long line → full-width rows in the pane
  await p1.waitForTimeout(1500); // stub echoes each char; let the grid fill
  await wide.close(); // disconnect; the pane keeps its (wide) geometry

  // ── 2. Narrow reopen: the replay must arrive fitted to THIS client.
  const narrow = await browser.newContext({ viewport: { width: 640, height: 480 }, storageState: ADMIN_STATE });
  const p2 = await narrow.newPage();
  await armWsRecorder(p2);
  const ws2 = p2.waitForEvent("websocket", { predicate: (w) => w.url().includes("/ws?subshell="), timeout: 60_000 });
  await p2.goto(`/subshells/${subshellId}`, { waitUntil: "domcontentloaded" });
  const attachUrl = (await ws2).url();
  const params = new URL(attachUrl).searchParams;
  const cols = Number(params.get("cols"));
  const rows = Number(params.get("rows"));
  expect(cols, "client must send cols on the attach URL").toBeGreaterThan(20);
  expect(rows, "client must send rows on the attach URL").toBeGreaterThan(5);

  await p2.waitForFunction(
    () => ((window as any).__wsFrames ?? []).some((f: Frame) => f.data.includes('"replay"')),
    undefined,
    { timeout: 60_000 },
  );
  const replay = JSON.parse((await subshellFrames(p2)).find((f) => f.data.includes('"replay"'))!.data) as {
    data: string;
  };
  const widest = Math.max(
    ...stripAnsi(replay.data)
      .split("\n")
      .map((l) => l.replace(/\r$/, "").length),
  );
  // The user-visible failure: rows wider than the terminal arrive re-wrapped
  // ("jumbled") and only self-correct on a manual resize.
  expect(widest, `replay rows must fit ${cols} cols (widest was ${widest})`).toBeLessThanOrEqual(cols + 2);
  expect(replay.data, "replay must carry the painted line").toContain("AAAA");

  // Every row break must carry a CARRIAGE RETURN. `capture-pane -p` emits
  // bare LFs, and a bare LF moves xterm's cursor down while KEEPING the
  // column — so each row starts where the previous ended (mod cols) and the
  // grid marches diagonally. It showed up only when scrolling UP (the live
  // diffs repaint the visible grid with absolute positioning; nothing ever
  // rewrites scrollback), which is why width-only assertions missed it.
  const bareLf = /[^\r]\n/.test(replay.data);
  expect(bareLf, "replay rows must be CRLF-terminated (a bare LF staircases scrollback)").toBe(false);

  // ── 3. Image paste into the focused terminal.
  // NOTE: headless Chromium never maps CDP Ctrl+V to the native paste (the
  // PASTE DIAG run proved zero paste events fire), so the OS-clipboard→event
  // leg is unreproducible headless. Everything AFTER the browser raises the
  // event — capture-phase interception, upload, injection — is driven with a
  // real bubbling `paste` event carrying a real clipboard-shaped DataTransfer.
  await p2.evaluate(() => {
    (window as any).__pasteLog = [] as unknown[];
    document.addEventListener(
      "paste",
      (e) => {
        (window as any).__pasteLog.push({
          target: (e.target as HTMLElement | null)?.className ?? null,
          files: e.clipboardData?.files.length ?? -1,
          items: e.clipboardData?.items.length ?? -1,
          types: Array.from(e.clipboardData?.types ?? []),
        });
      },
      true,
    );
  });
  await p2.locator(".xterm-helper-textarea").click();
  const upload = p2.waitForResponse((r) => r.url().includes("/uploads") && r.request().method() === "POST", {
    timeout: 15_000,
  });
  const dispatch = await p2.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e33";
    ctx.fillRect(0, 0, 300, 160);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));
    const file = new File([blob], "IMG_PROBE.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    const claimed = !(document.activeElement as HTMLElement).dispatchEvent(ev); // preventDefault ⇒ true
    (window as any).__pastePrevented = claimed;
    return { claimed, clipboardDataArrived: (ev as unknown as { clipboardData?: DataTransfer }).clipboardData != null };
  });
  console.log(
    "DISPATCH:",
    JSON.stringify(dispatch),
    "LOG:",
    JSON.stringify(await p2.evaluate(() => (window as any).__pasteLog)),
  );
  expect(dispatch.clipboardDataArrived, "DataTransfer must ride the dispatched event").toBe(true);
  expect(dispatch.claimed, "the app must claim (preventDefault) an image paste before xterm/the pane");
  const res = await upload; // RED if the paste falls through to the pane
  expect(res.status()).toBe(200);

  // The injected path leaves on the wire as a client `input` frame (recorded
  // above with the SENT marker); the stub's cat -v echo fragments it across
  // output frames, so the sent side is the deterministic assertion.
  await p2.waitForFunction(
    () =>
      ((window as any).__wsFrames ?? []).some(
        (f: Frame) => f.data.startsWith("SENT ") && f.data.includes('"input"') && f.data.includes(".subshell/uploads"),
      ),
    undefined,
    { timeout: 30_000 },
  );

  // Cleanup: terminate + delete the probe subshell.
  await p2.goto("/");
  const actions = p2.getByRole("button", { name: `Actions for ${name}` });
  await expect(actions).toBeVisible();
  await actions.click();
  await p2.getByRole("menuitem", { name: "Terminate" }).click();
  await p2.getByRole("button", { name: "Terminate" }).click();
  await actions.click();
  await p2.getByRole("menuitem", { name: "Delete subshell" }).click();
  await p2.getByRole("button", { name: "Delete" }).click();
  await narrow.close();
});
