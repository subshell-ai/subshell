import { describe, expect, it } from "bun:test";
import { REQUEST_LOG_IGNORE } from "@/plugins/context.plugin.js";

/** Does the ignore list cover this path, by either kind of entry? */
function ignored(path: string): boolean {
  return REQUEST_LOG_IGNORE.some((entry) => (typeof entry === "string" ? entry === path : entry.test(path)));
}

/**
 * The debug log's own worst enemy is the page that reads it.
 *
 * Request lines are written at `debug`, into ONE 200 KB file that is replaced
 * when full — so a polled route left off this list means turning debug logging
 * on destroys the history it was turned on to read. Nothing says which poll
 * did it; the log just keeps starting over.
 *
 * Every path here is polled by a surface somebody leaves open. Adding a poll
 * anywhere in the SPA means adding it here too, and this test is where that is
 * said out loud.
 */
describe("REQUEST_LOG_IGNORE", () => {
  it("covers every route the dashboard polls", () => {
    // The Service page, at 5 s and 1 s respectively.
    expect(ignored("/api/admin/server")).toBe(true);
    expect(ignored("/api/admin/server/logs")).toBe(true);
    // The Status page and the restart waiter.
    expect(ignored("/api/admin/status")).toBe(true);
    // Pre-auth polls: the setup screen and the sign-in page's instance name.
    expect(ignored("/api/setup/status")).toBe(true);
    expect(ignored("/api/settings/public")).toBe(true);
  });

  it("covers a node's log whatever its id is", () => {
    // One second per open node page, and the id is in the path — so this one
    // needs a pattern, and a string entry would silently never match.
    expect(ignored("/api/nodes/018f2c4e-1a2b-7c3d-9e4f-5a6b7c8d9e0f/logs")).toBe(true);
    expect(ignored("/api/nodes/local/logs")).toBe(true);
  });

  it("ignores the open pane view's preview poll but not its acts", () => {
    // The pane view polls GET /:id/preview while it is open (spec §7);
    // opening a forward or starting a watch changes what the pane does and
    // must stay in the log.
    expect(ignored("/api/subshells/018f2c4e-1a2b-7c3d-9e4f-5a6b7c8d9e0f/preview")).toBe(true);
    expect(ignored("/api/subshells/x/preview/open")).toBe(false);
    expect(ignored("/api/subshells/x/preview/watch")).toBe(false);
  });

  it("does not swallow the node routes that are ACTS rather than polls", () => {
    // Service verbs, repointing and the logging switch each change a machine.
    // Those lines are the reason an admin turns debug logging on at all.
    expect(ignored("/api/nodes/n1/service")).toBe(false);
    expect(ignored("/api/nodes/n1/logging")).toBe(false);
    expect(ignored("/api/nodes/n1/config")).toBe(false);
    expect(ignored("/api/nodes/n1")).toBe(false);
    expect(ignored("/api/nodes")).toBe(false);
  });

  it("ignores the WS paths and nothing that merely starts like them", () => {
    expect(ignored("/ws")).toBe(true);
    expect(ignored("/ws/node")).toBe(true);
    // A route that happens to begin with those letters is a different thing.
    expect(ignored("/wsx")).toBe(false);
  });

  it("ignores every /pv/ proxy path, because the session secret rides the path", () => {
    // A request line is a path, and for the preview proxy the path IS the
    // credential (spec 2026-10-21 §10): the 32-hex session ref is the only
    // secret standing between a log reader and anyone's forwarded pane port.
    // A debug log that records the request lines records every live link.
    expect(ignored("/pv/4f9c1a2b3d4e5f60718293a4b5c6d7e8/index.html")).toBe(true);
    expect(ignored("/pv/4f9c1a2b3d4e5f60718293a4b5c6d7e8/")).toBe(true);
    // Not merely the prefix shape: any depth, any verb's path.
    expect(ignored("/pv/deadbeefdeadbeefdeadbeefdeadbeef/ws/hmr")).toBe(true);
  });
});
