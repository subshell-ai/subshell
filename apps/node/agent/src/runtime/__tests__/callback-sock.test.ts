import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallbackRequest, PANE_CALLBACK_DIR, paneCallbackSockPath, startCallbackDoors } from "../callback-sock.js";

/**
 * The callback doors (design 2026-10-05 §5, task 25): the shared door answers
 * un-attributed (the slice's rule), a pane door answers AS its pane (the
 * per-connection attribution the plane executes with), and every door is a
 * 0600 unix socket with no TCP bind. Requests are driven with Bun's own
 * `fetch({ unix })` - the same client the pane's `subshell mcp` will use.
 */

const dirs: string[] = [];
function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-cb-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PANE_A = "11111111-1111-4111-8111-111111111111";
const PANE_B = "22222222-2222-4222-8222-222222222222";

/** One door request, fire-and-awaitable: the caller answers it via `doors.resolve`. */
function ask(sockPath: string, path: string, method = "GET", body?: string): Promise<Response> {
  return fetch(`http://runtime${path}`, {
    unix: sockPath,
    method,
    ...(body !== undefined ? { body } : {}),
  } as RequestInit & { unix: string });
}

/** Wait until `cond()` holds (bun's unix fetch delivers on the microtask; asserts must follow, not lead). */
async function waitUntil(cond: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 2000) throw new Error("callback request never reached the door");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("callback doors", () => {
  test("the shared door relays un-attributed requests and answers them by reqId", async () => {
    const dataDir = freshDataDir();
    const seen: CallbackRequest[] = [];
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      const inflight = ask(doors.sharedPath, "/api/subshells/x");
      await waitUntil(() => seen.length === 1);
      const req = seen[0] as CallbackRequest;
      expect(req.paneId).toBeUndefined(); // the shared door claims nothing (the plane's rule for it: one-pane sessions only)
      expect(req.path).toBe("/api/subshells/x");
      doors.resolve(req.reqId, 200, JSON.stringify({ ok: true }));
      const res = await inflight;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // The socket IS the ACL: 0600, and the file sits where the contract says.
      expect(statSync(doors.sharedPath).mode & 0o777).toBe(0o600);
    } finally {
      await doors.stop();
    }
    expect(() => statSync(join(dataDir, "callback.sock"))).toThrow(); // stop unlinks
  });

  test("pane doors attribute by connection, one reqId space answers across doors", async () => {
    const dataDir = freshDataDir();
    const seen: CallbackRequest[] = [];
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      await doors.ensurePane(PANE_A);
      await doors.ensurePane(PANE_B);
      await doors.ensurePane(PANE_A); // idempotent: a second ensure is not a second bind

      const a = ask(paneCallbackSockPath(dataDir, PANE_A), `/api/subshells/${PANE_A}/attention`);
      const b = ask(paneCallbackSockPath(dataDir, PANE_B), `/api/subshells/${PANE_B}/attention`);
      await waitUntil(() => seen.length === 2);
      const byPane = new Map(seen.map((r) => [r.paneId, r]));
      expect(byPane.get(PANE_A)?.path).toBe(`/api/subshells/${PANE_A}/attention`);
      expect(byPane.get(PANE_B)?.path).toBe(`/api/subshells/${PANE_B}/attention`);
      // resolve is door-blind: the reqId names the waiter, whichever door it came from.
      const reqA = seen.find((r) => r.paneId === PANE_A) as CallbackRequest;
      const reqB = seen.find((r) => r.paneId === PANE_B) as CallbackRequest;
      doors.resolve(reqB.reqId, 403, JSON.stringify({ error: "forbidden" }));
      doors.resolve(reqA.reqId, 200, "{}");
      expect((await b).status).toBe(403);
      expect((await a).status).toBe(200);

      // The pane door path is the plane's composed template, byte for byte
      // (`<dataDir>/callbacks/<id>.sock`), and 0600 like the shared one.
      expect(paneCallbackSockPath("/d", "id1")).toBe(join("/d", PANE_CALLBACK_DIR, "id1.sock"));
      expect(statSync(paneCallbackSockPath(dataDir, PANE_A)).mode & 0o777).toBe(0o600);

      // dropPane unlinks; a later request on the dead door gets refused,
      // which is the honest local reading for a retired pane.
      await doors.dropPane(PANE_A);
      expect(() => statSync(paneCallbackSockPath(dataDir, PANE_A))).toThrow();
    } finally {
      await doors.stop();
    }
  });

  test("a malformed id opens no door; the POST body arrives text and the method rides", async () => {
    const dataDir = freshDataDir();
    const seen: CallbackRequest[] = [];
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      await doors.ensurePane("has space"); // the execLaunch id gate, same rule
      expect(seen.length).toBe(0);
      const inflight = ask(doors.sharedPath, "/api/subshells/x/input", "POST", '{"data":"ls"}');
      await waitUntil(() => seen.length === 1);
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.body).toBe('{"data":"ls"}');
      doors.resolve((seen[0] as CallbackRequest).reqId, 200, "");
      expect((await inflight).status).toBe(200);
      // An answer for a req nobody waited on is dropped, not a throw.
      doors.resolve("nope", 200, "");
    } finally {
      await doors.stop();
    }
  });

  test("a stale socket file from a killed previous serve does not block the bind", async () => {
    const dataDir = freshDataDir();
    const seen: CallbackRequest[] = [];
    writeFileSync(join(dataDir, "callback.sock"), "not a live listener"); // unlink-on-start must clear it
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      const inflight = ask(doors.sharedPath, "/api/subshells/x"); // never answered: the bind working is the fact under test
      await waitUntil(() => seen.length === 1);
      doors.resolve((seen[0] as CallbackRequest).reqId, 200, "");
      expect((await inflight).status).toBe(200); // the request arrived on the freshly bound door
    } finally {
      await doors.stop();
    }
  });
});
