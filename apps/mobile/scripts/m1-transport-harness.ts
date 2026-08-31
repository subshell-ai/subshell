/**
 * M1 transport harness — runs the app's REAL transport code (`MoteClient`, the
 * cookie module, the protocol package) against a live mote instance, from this
 * shell, with no emulator, phone or Xcode involved.
 *
 * It exists to falsify or confirm the single riskiest assumption in the design:
 * that a header-cookie client can do everything the app needs — including
 * minting a WebSocket attach token, which `api/ws-token.route.ts:26` refuses to
 * any non-cookie actor.
 *
 * Usage:
 *   MOTE_BASE_URL=http://127.0.0.1:3080 MOTE_EMAIL=… MOTE_PASSWORD=… bun run harness:m1
 *
 * Set MOTE_SEND_INPUT=1 to additionally type a newline into a session you name
 * with MOTE_SESSION_HINT (matched against the session name). Off by default:
 * keystrokes go to a real agent's pane, and the token's owner can inject into
 * any session they own.
 */

import { MoteClient, type TokenStore } from "@/lib/api";
import { wsOrigin } from "@/lib/instance-url";
import type { SessionView, WsTokenResponse } from "@/types/session";

const BASE = process.env.MOTE_BASE_URL ?? "http://127.0.0.1:3080";
const EMAIL = process.env.MOTE_EMAIL ?? "";
const PASSWORD = process.env.MOTE_PASSWORD ?? "";
const SEND_INPUT = process.env.MOTE_SEND_INPUT === "1";
const HINT = process.env.MOTE_SESSION_HINT ?? "";

let failures = 0;
const ok = (label: string, detail = ""): void => {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label: string, detail = ""): void => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};
const step = (n: string): void => console.log(`\n=== ${n} ===`);

/** Process-local token store — deliberately never writes to disk. */
function memoryStore(): TokenStore & { value: string | null } {
  const state = {
    value: null as string | null,
    get: async () => state.value,
    set: async (t: string) => {
      state.value = t;
    },
    clear: async () => {
      state.value = null;
    },
  };
  return state;
}

async function main(): Promise<void> {
  console.log(`mote M1 transport harness → ${BASE}`);
  const store = memoryStore();
  let unauthorized = 0;
  const client = new MoteClient({ baseUrl: BASE, store, onUnauthorized: () => unauthorized++ });

  step("1/6 public endpoint reachable (no credential)");
  try {
    const res = await fetch(`${BASE}/api/setup/status`);
    const body = (await res.json()) as { needsSetup?: boolean; hasUsers?: boolean };
    res.status === 200
      ? ok("GET /api/setup/status", JSON.stringify(body))
      : bad("GET /api/setup/status", `HTTP ${res.status}`);
  } catch (err) {
    bad("GET /api/setup/status", err instanceof Error ? err.message : String(err));
    console.log("\nInstance unreachable — nothing else can be checked.");
    process.exit(1);
  }

  step("2/6 sign in as the cookie actor");
  if (!EMAIL || !PASSWORD) {
    bad("sign-in", "set MOTE_EMAIL and MOTE_PASSWORD");
    console.log("\nSkipped the rest — the whole point of M1 is the authenticated path.");
    process.exit(1);
  }
  try {
    const session = await client.signIn(EMAIL, PASSWORD);
    session.token && session.token.length > 10
      ? ok("POST /api/auth/sign-in/email", `token in body, ${session.token.length} chars`)
      : bad("sign-in", "response carried no session token in the body");
  } catch (err) {
    bad("sign-in", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  step("3/6 guarded route reads through the Cookie header");
  let sessions: SessionView[] = [];
  try {
    sessions = await client.sessions();
    ok("GET /api/sessions", `${sessions.length} session(s)`);
  } catch (err) {
    bad("GET /api/sessions", err instanceof Error ? err.message : String(err));
  }

  step("4/6 ws-token mint — the gate that forces cookie auth");
  let wsToken: string | null = null;
  try {
    const res = await client.wsToken();
    wsToken = (res as WsTokenResponse).token ?? null;
    wsToken
      ? ok("POST /api/auth/ws-token", `token ${wsToken.length} chars, single-use, 30s TTL`)
      : bad("ws-token", "no token");
  } catch (err) {
    bad("POST /api/auth/ws-token", err instanceof Error ? err.message : String(err));
    console.log("  ^ a 403 here would mean the cookie actor is not being recognised.");
  }

  step("5/6 negative control — anonymous mint must be rejected");
  try {
    const res = await fetch(`${BASE}/api/auth/ws-token`, { method: "POST" });
    res.status === 401 || res.status === 403
      ? ok("anonymous ws-token", `rejected with ${res.status}`)
      : bad("anonymous ws-token", `unexpectedly returned ${res.status}`);
  } catch (err) {
    bad("anonymous ws-token", err instanceof Error ? err.message : String(err));
  }

  step("6/6 attach /ws and read frames");
  const target =
    sessions.find((s) => (HINT ? s.name.toLowerCase().includes(HINT.toLowerCase()) : false)) ??
    sessions.find((s) => s.status === "running" && s.alive) ??
    sessions[0];
  if (!target) {
    bad("attach", "the user owns no sessions — create one in the web app first");
  } else if (!wsToken) {
    bad("attach", "no ws-token to attach with");
  } else {
    const url = `${wsOrigin(BASE)}/ws?session=${encodeURIComponent(target.id)}&token=${encodeURIComponent(wsToken)}`;
    console.log(`  target: "${target.name}" (${target.status}${target.alive ? "" : ", not alive"})`);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      const seen: string[] = [];
      const done = (verdict: "PASS" | "FAIL", detail: string): void => {
        console.log(`  ${verdict}  /ws ${target.id.slice(0, 8)} — ${detail} (frames: ${seen.join(",") || "none"})`);
        if (verdict === "FAIL") failures += 1;
        try {
          ws.close();
        } catch {}
        resolve();
      };
      const timer = setTimeout(() => done(seen.includes("replay") ? "PASS" : "FAIL", "timed out after 12s"), 12000);
      ws.onopen = () => console.log("  socket open");
      ws.onmessage = (ev) => {
        let frame: { type?: string; data?: string };
        try {
          frame = JSON.parse(String(ev.data)) as { type?: string; data?: string };
        } catch {
          clearTimeout(timer);
          done("FAIL", `non-JSON frame: ${String(ev.data).slice(0, 40)}`);
          return;
        }
        if (frame.type && !seen.includes(frame.type)) seen.push(frame.type);
        const bytes = frame.data ? new TextEncoder().encode(frame.data).length : 0;
        if (frame.type === "replay") {
          if (SEND_INPUT && HINT && target.name.toLowerCase().includes(HINT.toLowerCase())) {
            console.log("  MOTE_SEND_INPUT=1 → sending a newline to this pane");
            ws.send(JSON.stringify({ type: "input", data: "\r" }));
          }
          clearTimeout(timer);
          done("PASS", `replay ${bytes} bytes`);
        } else if (frame.type === "output") {
          clearTimeout(timer);
          done(seen.includes("replay") ? "PASS" : "FAIL", `output ${bytes} bytes without a preceding replay`);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        done("FAIL", "socket error — a proxy that does not forward Upgrade looks exactly like this");
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const code = ev.code ?? 0;
        // 4000 attach failed, 4001 unauthorized, 4004 not found/not running.
        if (code >= 4000) done("FAIL", `server rejected the attach with close code ${code}`);
        else done(seen.includes("replay") ? "PASS" : "FAIL", `closed code=${code} ${ev.reason || ""}`.trim());
      };
    });
  }

  if (unauthorized > 0) bad("401 handler", `fired ${unauthorized}× — the token was rejected mid-run`);
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
