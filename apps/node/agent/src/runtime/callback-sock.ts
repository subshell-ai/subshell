import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { isSubshellId } from "../subshell-meta.js";
import { diag } from "./stdio.js";

/**
 * The callback unix doors (design 2026-10-05 §5, task 25): listeners at
 * `<runtimeDataDir>/...`, mode 0600, the ONE listener class permitted by "no
 * inbound network listener" - inside the destination OS-account boundary,
 * never a TCP bind.
 *
 * TWO door kinds, one mechanism (Bun's unix-socket HTTP):
 * - the SHARED door `<dataDir>/callback.sock` (the slice's surface): whoever
 *   connects here identifies themselves by the PATH they request, and the
 *   plane's rule for such frames is unchanged - resolvable only for a
 *   one-pane session. This is the door the design §9 acceptance curl uses.
 * - the PER-PANE doors `<dataDir>/callbacks/<paneId>.sock` (task 25): the
 *   runtime creates one when a pane is launched (and re-creates them for the
 *   meta-store's panes when a session reconciles a live destination), and
 *   every request accepted on a pane's own door is attributed to that pane by
 *   the CONNECTION - the door it dialed, not anything it typed. That is what
 *   lets a multi-pane session execute each callback as its own pane's token
 *   while NO credential ever crosses the wire: the pane's env names its own
 *   door (the plane bakes `SUBSHELL_RUNTIME_CALLBACK_SOCK` at launch), and the
 *   plane maps door -> pane with facts it minted itself.
 *
 * The requests are relayed as `rest_request` frames (paneId on the pane doors,
 * absent on the shared one) and answered by the matching `rest_response` the
 * plane sends back over the session. The runtime never interprets the path:
 * the ALLOWLIST is the plane's decision (it executes as the pane's own token),
 * and forwarding anything else is what keeps this file free of duplicated
 * policy. A request that outlives {@link CALLBACK_TIMEOUT_MS} answers 504 -
 * the plane stopped answering, which is exactly what a lost session looks
 * like from the pane side.
 */

/** How long one callback waits for the plane's answer before answering 504 (a wedged session must not wedge a pane). */
const CALLBACK_TIMEOUT_MS = 30_000;

/** The pane doors' namespace beside the shared socket. */
export const PANE_CALLBACK_DIR = "callbacks";

/** One pane's door path under a runtime data dir - the SAME template the plane composes into the pane env (pinned equal by test on both sides). */
export function paneCallbackSockPath(dataDir: string, subshellId: string): string {
  return join(dataDir, PANE_CALLBACK_DIR, `${subshellId}.sock`);
}

/** An in-flight callback the serve loop must answer with `rest_response`. */
export interface CallbackRequest {
  reqId: string;
  method: string;
  path: string;
  body?: string;
  /** Set when the request arrived on this pane's own door (per-connection attribution); absent on the shared door. */
  paneId?: string;
}

/**
 * The runtime's callback doors. `ensurePane`/`dropPane` manage the per-pane
 * namespace; the shared door is opened by the constructor call and lives as
 * long as the serve process. `resolve` is one flat surface: reqIds are uuids
 * (collision-free across panes), so the plane's answer needs no door naming -
 * the owning door is found by the id it carries.
 */
export interface CallbackDoors {
  /** Absolute path of the SHARED door (the slice's surface; hello reports the data dir it sits in). */
  readonly sharedPath: string;
  /** Open (or keep) one pane's door. Idempotent; a throwing bind logs and leaves the pane un-attributed rather than killing the session. */
  ensurePane(subshellId: string): Promise<void>;
  /** Close and unlink one pane's door (terminate/kill/exit; unknown ids are no-ops). */
  dropPane(subshellId: string): Promise<void>;
  /** Deliver the plane's answer for one in-flight request (unknown reqIds are dropped: the waiter already 504'd). */
  resolve(reqId: string, status: number, body: string): void;
  /** Close every door and unlink every socket file (idempotent). */
  stop(): Promise<void>;
}

/** Mint a callback request id; uuid keeps it collision-free across panes and reconnects. */
function newReqId(): string {
  return crypto.randomUUID();
}

/**
 * The bind refused a path another session is LISTENING on (review m2). The
 * name is a routing fact, not a nicer message: `serve.ts`'s bootstrap maps
 * THIS kind (and no other startup failure) to the busy exit code the broker
 * classifies as `session_in_use`, so "the destination is taken" must be
 * tellable apart from "the serve broke on the way up".
 */
export class LiveCallbackDoorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCallbackDoorError";
  }
}

/** One bound listener: its own pending map, its own unlink discipline. */
interface Door {
  server: ReturnType<typeof Bun.serve> | undefined;
  readonly path: string;
  readonly paneId?: string;
  readonly pending: Map<string, { settle(status: number, body: string): void }>;
}

/**
 * Is another process LISTENING on this exact path? A refused connect (or a
 * non-socket file, or a timeout - the kernel answers ECONNREFUSED for a
 * socket inode whose owner died) is the honest word for STALE, which is the
 * file §6's reconciliation exists to clear. A path that ACCEPTS is a live
 * door belonging to a session, and stealing it (the I5 collision: a second
 * live serve's reconcile loop unlinked the first session's pane doors, so
 * every callback moved onto a channel that never issued those panes' tokens
 * and 403'd them) is refused instead - HERE, at the bind, and that is the
 * whole enforcement. The plane deliberately runs no refuse-a-second-live-
 * session gate (review m1: `openSession` asks only the per-node quota): a
 * pre-open refusal would misread every REOPEN after a lost or closed
 * session, which design §6 requires to adopt the destination's surviving
 * panes, as a collision. What the plane cannot see across sessions, the
 * bind can: both serves share the destination's filesystem, and the live
 * listener IS the other session's proof of life.
 *
 * The stated residual (review m1, accepted): probe → unlink → bind is not
 * atomic, so two serves starting for one destination within bind distance
 * can both pass the probe and the later unlink steals the earlier bind
 * (path → new inode; the robbed serve keeps answering only its already-
 * connected clients). Narrow by construction - two concurrent OPEN acts on
 * one destination, in a single-user instance - and a lockfile dance across
 * process starts costs the reconcile path more than the race is worth.
 */
function hasLiveListener(path: string, budgetMs = 250): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path });
    let settled = false;
    const settle = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(budgetMs, () => settle(false)); // a silent accept is not an answering door either
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** Bind one door: refuse a LIVE path, unlink a stale one, bind, then PIN the mode to 0600. */
async function bindDoor(
  path: string,
  paneId: string | undefined,
  onRequest: (req: CallbackRequest) => void,
): Promise<Door> {
  if (existsSync(path) && (await hasLiveListener(path))) {
    throw new LiveCallbackDoorError(`callback socket path has a live listener (another session serves it): ${path}`);
  }
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // races with the bind error path; nothing to interpret
    }
  }
  const door: Door = {
    server: undefined,
    path,
    ...(paneId !== undefined ? { paneId } : {}),
    pending: new Map(),
  };
  door.server = Bun.serve({
    unix: path,
    // No `port`: a unix socket and nothing else. The Gate A proof asserts the
    // serve process listens on no TCP socket at all; adding a port would fail
    // that test on purpose.
    fetch: async (request) => {
      const url = new URL(request.url);
      const reqId = newReqId();
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      return await new Promise<Response>((resolve) => {
        const settle = (status: number, text: string): void => {
          // A second settle (timeout raced the plane's answer) must not
          // resolve the promise twice: resolve is idempotent, but the map
          // delete must stay guarded or the answer arrives after eviction.
          if (!door.pending.delete(reqId)) return;
          resolve(
            new Response(text, {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        };
        door.pending.set(reqId, { settle });
        const timer = setTimeout(() => {
          settle(504, JSON.stringify({ error: "runtime_callback_timeout" }));
        }, CALLBACK_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        onRequest({
          reqId,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          ...(body !== undefined ? { body } : {}),
          ...(door.paneId !== undefined ? { paneId: door.paneId } : {}),
        });
      });
    },
  });
  // The socket IS the access control surface: mode 0600 pins it to this OS
  // user before any pane could connect (bind creates it 0755-and-umask).
  // Acknowledged microsecond window between `listen` and this chmod (the
  // pane-log-hygiene posture, restated): the path lives inside a 0700 dir
  // that only this OS user can even traverse, so the directory mode is the
  // door and the file mode the belt; a same-user connector could race the
  // chmod, and a same-user attacker is the accepted boundary (security.md §0).
  try {
    chmodSync(path, 0o600);
  } catch {
    await door.server.stop();
    throw new Error(`callback socket mode refused: ${path}`);
  }
  return door;
}

/** Close one door: answer its in-flight callbacks 503 (the door is going away under a live request), stop, unlink. */
async function closeDoor(door: Door): Promise<void> {
  for (const [reqId, pending] of [...door.pending]) {
    door.pending.delete(reqId);
    pending.settle(503, JSON.stringify({ error: "runtime_callback_door_closed" }));
  }
  try {
    await door.server?.stop(true);
  } catch {
    // already down
  }
  try {
    unlinkSync(door.path);
  } catch {
    // already unlinked
  }
}

/**
 * Open the shared door and return the manager that owns every door from here
 * on. The pane-door directory is created on first `ensurePane` (a session
 * that never launches a preset pane never makes it).
 *
 * @param dataDir - the runtime's data dir (0700); the shared socket lands at `<dataDir>/callback.sock`
 * @param onRequest - called for each inbound pane callback; the serve loop frames it and awaits the plane
 */
export async function startCallbackDoors(
  dataDir: string,
  onRequest: (req: CallbackRequest) => void,
): Promise<CallbackDoors> {
  const sharedPath = join(dataDir, "callback.sock");
  const paneDir = join(dataDir, PANE_CALLBACK_DIR);
  const doors = new Map<string, Door>(); // key: paneId for pane doors, "" for the shared door
  doors.set("", await bindDoor(sharedPath, undefined, onRequest));

  return {
    sharedPath,
    async ensurePane(subshellId: string): Promise<void> {
      if (!isSubshellId(subshellId)) return; // the same id gate execLaunch enforces
      if (doors.has(subshellId)) return;
      mkdirSync(paneDir, { recursive: true, mode: 0o700 });
      try {
        doors.set(subshellId, await bindDoor(paneCallbackSockPath(dataDir, subshellId), subshellId, onRequest));
      } catch (err) {
        // A pane whose door will not bind still LAUNCHES (the door is the
        // callback surface, not the pane's); the failure is a diagnostic line,
        // and its curl gets connection-refused - the honest local reading.
        diag(
          `runtime: pane callback door refused for ${subshellId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    async dropPane(subshellId: string): Promise<void> {
      const door = doors.get(subshellId);
      if (door === undefined) return;
      doors.delete(subshellId);
      await closeDoor(door);
    },
    resolve(reqId: string, status: number, body: string): void {
      // Scan the doors: a session holds a handful of panes, and the map's key
      // is the reqId. No side routing table to age out is the simpler honest
      // structure, and `settle` is self-guarding (it claims the pending entry
      // by deleting it), so the timeout race answers once, not twice.
      for (const door of doors.values()) {
        const pending = door.pending.get(reqId);
        if (pending !== undefined) {
          pending.settle(status, body);
          return;
        }
      }
    },
    async stop(): Promise<void> {
      for (const [key, door] of [...doors]) {
        doors.delete(key);
        await closeDoor(door);
      }
    },
  };
}
