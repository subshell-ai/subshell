import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The callback unix socket (design 2026-10-05 §5): `<runtimeDataDir>/
 * callback.sock`, mode 0600, the ONE listener class permitted by "no inbound
 * network listener" - inside the destination OS-account boundary, never a TCP
 * bind.
 *
 * It speaks the smallest HTTP any pane needs: `subshell mcp` (later) and the
 * design's acceptance call - `curl --unix-socket <sock> http://runtime/api/
 * subshells/<own-id>` - today. A request line is parsed by Bun's own HTTP
 * server, mapped to one `rest_request` frame, answered by the matching
 * `rest_response` the plane sends back over the session. The runtime never
 * interprets the path: the ALLOWLIST is the plane's decision (it executes as
 * the pane's own token), and forwarding anything else is what keeps this file
 * free of duplicated policy. A request that outlives {@link
 * CALLBACK_TIMEOUT_MS} answers 504 - the plane stopped answering, which is
 * exactly what a lost session looks like from the pane side.
 */

/** How long one callback waits for the plane's answer before answering 504 (a wedged session must not wedge a pane). */
const CALLBACK_TIMEOUT_MS = 30_000;

/** An in-flight callback the serve loop must answer with `rest_response`. */
export interface CallbackRequest {
  reqId: string;
  method: string;
  path: string;
  body?: string;
}

export interface CallbackSocket {
  /** Absolute socket path (the pane's env names it; hello reports the data dir it sits in). */
  readonly path: string;
  /** Deliver the plane's answer for one in-flight request (unknown reqIds are dropped: the waiter already 504'd). */
  resolve(reqId: string, status: number, body: string): void;
  /** Close the listener and unlink the socket file (idempotent). */
  stop(): Promise<void>;
}

/** Mint a callback request id; uuid keeps it collision-free across panes and reconnects. */
function newReqId(): string {
  return crypto.randomUUID();
}

/**
 * Open the callback socket.
 *
 * @param dataDir - the runtime's data dir (0700); the socket lands at `<dataDir>/callback.sock`
 * @param onRequest - called for each inbound pane callback; the serve loop frames it and awaits the plane
 */
export async function startCallbackSocket(
  dataDir: string,
  onRequest: (req: CallbackRequest) => void,
): Promise<CallbackSocket> {
  const path = join(dataDir, "callback.sock");
  // A stale socket from a killed previous serve would bind-fail; unlinking a
  // path that is not ours to own (live listener) fails with EADDRINUSE below,
  // which is the honest refusal.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // races with the bind error path; nothing to interpret
    }
  }
  const pending = new Map<string, { settle(status: number, body: string): void }>();

  const server = Bun.serve({
    unix: path,
    // No `port`: a unix socket and nothing else. The Gate A proof asserts the
    // serve process listens on no TCP socket at all; adding a port would fail
    // that test on purpose.
    fetch: async (request) => {
      const url = new URL(request.url);
      const reqId = newReqId();
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const answered = new Promise<Response>((resolve) => {
        let settled = false;
        const settle = (status: number, text: string): void => {
          if (settled) return;
          settled = true;
          resolve(
            new Response(text, {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        };
        pending.set(reqId, { settle });
        const timer = setTimeout(() => {
          settle(504, JSON.stringify({ error: "runtime_callback_timeout" }));
        }, CALLBACK_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        onRequest({
          reqId,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          ...(body !== undefined ? { body } : {}),
        });
      }).finally(() => {
        pending.delete(reqId);
      });
      return answered;
    },
  });
  // The socket IS the access control surface: mode 0600 pins it to this OS
  // user before any pane could connect (bind creates it 0755-and-umask).
  try {
    chmodSync(path, 0o600);
  } catch {
    await server.stop();
    throw new Error(`callback socket mode refused: ${path}`);
  }

  let stopped = false;
  return {
    path,
    resolve: (reqId, status, body) => {
      pending.get(reqId)?.settle(status, body);
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await server.stop(true);
      } catch {
        // already down
      }
      try {
        unlinkSync(path);
      } catch {
        // already unlinked
      }
    },
  };
}
