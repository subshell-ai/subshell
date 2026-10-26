import { describe, expect, it } from "bun:test";
import { NODE_SCREEN_IDS, screenTitle, serviceAction } from "@/lib/node-assistant-state";

/*
 * `screenFor` is GONE, and so is its block of cases here.
 *
 * It answered "which screen does this machine imply", which the first run
 * (spec 2026-09-18) replaced with a question that has to come first: what did
 * this person come to do. `clientScreen` in `lib/client-flow.ts` answers both,
 * and `client-flow.test.ts` carries the routing cases — including the three
 * `screenFor` owned that still hold (nothing read yet ⇒ null, an override
 * outranks the machine, and a step this build predates still lands somewhere
 * that shows the facts). The three the first run reversed on purpose are
 * asserted there in their new form: a plane address no longer comes first, a
 * configured client lands on `status` rather than on a probe-derived screen,
 * and an untouched machine opens on Welcome rather than on Connect.
 */

describe("screenTitle", () => {
  it("names every screen, including the ones the first run added", () => {
    // The switch is exhaustive, so a missing id is a type error rather than a
    // test failure — what this pins is that none of them answers an empty
    // string, which the compiler would accept and the frame would render as a
    // screen with no heading.
    for (const screen of NODE_SCREEN_IDS) {
      expect(screenTitle(screen).trim().length, screen).toBeGreaterThan(0);
    }
  });

  // The three service-state titles this used to pin went with the service
  // screen: a configured machine lands on `status`, whose heading is the
  // app's name and whose badge and problem line are what say which failure
  // it is looking at (`status-screen.test.tsx`).
  it("has ONE update screen, named for the product the person is looking at", () => {
    // This used to pin the opposite premise — that the APP's update and the
    // AGENT's must never share a word — because there were two screens with
    // two buttons. Spec 2026-09-18 made them one act in two phases (this app
    // SHIPS the agent it drives), so the thing to hold is that there is one
    // screen: `app-update` is DELETED from the ids rather than aliased, which
    // this product can do because it has no installed base to keep compatible,
    // and an id this build does not know is ignored as it always was.
    expect(NODE_SCREEN_IDS as readonly string[]).toContain("update");
    expect(NODE_SCREEN_IDS as readonly string[]).not.toContain("app-update");
  });
});

describe("serviceAction", () => {
  it("offers the one verb the step needs", () => {
    expect(serviceAction("no-service")).toEqual({ label: "Install and Start", verb: "install" });
    expect(serviceAction("stopped")).toEqual({ label: "Start", verb: "start" });
    expect(serviceAction("offline")).toEqual({ label: "Restart", verb: "restart" });
    expect(serviceAction("online")).toBeNull();
    expect(serviceAction("no-node")).toBeNull();
    expect(serviceAction("not-enrolled")).toBeNull();
  });
});
