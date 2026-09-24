import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  detachViewer,
  dropTerminalSocketsFor,
  registerViewer,
  resetLiveViewersForTests,
  type WsData,
  type WsSocket,
} from "@/ws/viewers.js";

/**
 * {@link dropTerminalSocketsFor} — the account-disable drop for browser
 * TERMINAL attaches, the sibling of `dropLiveSocketsFor` for `/ws/live`.
 *
 * A terminal socket authenticates at connect and is never re-checked, and it
 * lives in `liveViewers` (keyed by subshell and viewer), NOT in the live-feed
 * registry the disable originally swept — so closing it needs a walk keyed by
 * the `attachUserId` the attach stashed. The two properties the walk must
 * have: it finds the user's socket on ANY pane they watch (their own or a
 * shared one), and it touches no other viewer of those same panes.
 */
function viewer(userId: string | undefined, viewerId: string, subshellId = "sub-1") {
  const closed: { code?: number; reason?: string }[] = [];
  // `subshellId` rides the data exactly as both attach paths assign it, so
  // `detachViewer` (which reads it) behaves on the fake as on a real socket.
  const data: Partial<WsData> = { viewerId, subshellId };
  if (userId !== undefined) data.attachUserId = userId;
  const ws = {
    data,
    send: () => 1,
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
  } as unknown as WsSocket;
  return { ws, closed };
}

beforeEach(() => resetLiveViewersForTests());
afterEach(() => resetLiveViewersForTests());

describe("dropTerminalSocketsFor", () => {
  it("closes the user's sockets on every pane they watch, shared ones included", () => {
    // Enumerating the user's OWNED subshells would miss `sharedPane` — a
    // terminal open on someone else's pane is exactly as stale as one on
    // their own. The walk is by WHO attached, not what they attached to.
    const own = viewer("u1", "v-own", "sub-mine");
    const sharedPane = viewer("u1", "v-shared", "sub-theirs");
    registerViewer(own.ws, "sub-mine");
    registerViewer(sharedPane.ws, "sub-theirs");

    expect(dropTerminalSocketsFor("u1", "account disabled")).toBe(2);
    expect(own.closed).toEqual([{ code: 1012, reason: "account disabled" }]);
    expect(sharedPane.closed).toEqual([{ code: 1012, reason: "account disabled" }]);
  });

  it("leaves every OTHER viewer of the same panes attached", () => {
    // The over-close the owner-enumeration alternative would commit: a
    // bystander sharing the disabled user's pane is not disabled, and closing
    // their terminal to "fix" the owner's is collateral. Only the match is
    // closed.
    const disabled = viewer("u1", "v-1");
    const bystander = viewer("u2", "v-2");
    registerViewer(disabled.ws, "sub-shared");
    registerViewer(bystander.ws, "sub-shared");

    expect(dropTerminalSocketsFor("u1", "account disabled")).toBe(1);
    expect(bystander.closed).toEqual([]);
  });

  it("closes with 1012 — the house code BELOW 4000, so the client reconnects", () => {
    // 1012 is `dropLiveSocketsFor`'s and `performRestart`'s code for exactly
    // this reason: the client reads the 4xxx range as a refusal to report
    // and anything under it as a connection to retry.
    const { ws, closed } = viewer("u1", "v-1");
    registerViewer(ws, "sub-1");
    dropTerminalSocketsFor("u1");
    expect(closed[0]?.code).toBe(1012);
  });

  it("stops matching once the socket's own close handler detached it", () => {
    // The registry stays the close handler's bookkeeping (the `closeAllViewers`
    // discipline); this proves the walk follows it rather than caching.
    const { ws } = viewer("u1", "v-1");
    registerViewer(ws, "sub-1");
    expect(dropTerminalSocketsFor("u1")).toBe(1);
    detachViewer(ws);
    expect(dropTerminalSocketsFor("u1")).toBe(0);
  });

  it("a socket whose attach never resolved a user is never dropped for someone else", () => {
    const ghost = viewer(undefined, "v-ghost");
    registerViewer(ghost.ws, "sub-1");
    expect(dropTerminalSocketsFor("u1")).toBe(0);
    expect(ghost.closed).toEqual([]);
  });

  it("is harmless for a user with no sockets, and for a throwing close", () => {
    expect(dropTerminalSocketsFor("nobody")).toBe(0);
    const ws = {
      data: { viewerId: "v-throw", attachUserId: "u1" },
      send: () => 1,
      close: () => {
        throw new Error("already gone");
      },
    } as unknown as WsSocket;
    registerViewer(ws, "sub-1");
    expect(() => dropTerminalSocketsFor("u1")).not.toThrow();
  });
});
