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

  it("walks the first run in the assistant's voice", () => {
    expect(screenTitle("welcome")).toBe("Welcome to Subshell Client");
    expect(screenTitle("choice")).toBe("What Would You Like to Do?");
    expect(screenTitle("tmux")).toBe("Install tmux");
    expect(screenTitle("register")).toBe("Register This Machine");
    expect(screenTitle("startup")).toBe("How This Node Runs");
    expect(screenTitle("progress")).toBe("Setting Up…");
    expect(screenTitle("status")).toBe("Subshell Client");
  });

  it("keeps the two registration words apart", () => {
    // "Register" is this window's word; "Enroll" is the CLI's. The window's
    // second use of "Enroll" — the destructive re-enrolment screen — retired
    // with the Control Plane collapse (operator ruling 2026-09-22), so the
    // one word per act is now the whole rule: no title here says "Enroll".
    expect(screenTitle("register")).not.toContain("Enroll");
    for (const id of NODE_SCREEN_IDS) expect(screenTitle(id)).not.toContain("Enroll");
  });

  // The three service-state titles this used to pin went with the service
  // screen: a configured machine lands on `status`, whose heading is the
  // app's name and whose badge and problem line are what say which failure
  // it is looking at (`status-screen.test.tsx`).
  it("speaks the assistant's voice on the screens a person asks for", () => {
    expect(screenTitle("connect")).toBe("Connect to a Server");
    expect(screenTitle("about")).toBe("About Subshell Client");
    expect(screenTitle("update")).toBe("Update Subshell Client");
  });

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
    // The title names the APP because the app is what the person opened and
    // what relaunches. The node half is the tail of that same act and is
    // stated on the screen — `update-act.test.ts` pins both rows — rather than
    // in a heading that would then name two products.
    expect(screenTitle("update")).toBe("Update Subshell Client");
  });

  it("names the product rather than the computer, identically on both platforms", () => {
    // Two regressions pinned at once, both reported from a screenshot on
    // 2026-09-12. "Reset This Mac" reads as erasing the computer, which is
    // not remotely what this does; and a label ending on "Mac" reads as a
    // truncated "Machine", against a sibling string that really is "This
    // Machine". This is the one title that names no machine on any platform.
    // (Reset's title retired with the screen: the confirmation is a dialog
    // now — "Reset everything?" — and a dialog is named by its Dialog role,
    // operator ruling 2026-09-22.)
    // And the rule it became: NO title names a Mac, because there is one word
    // for where you are and it is "This Machine" (operator's call,
    // 2026-09-12). A title is a label; a label that might have been cut off is
    // a bug report waiting to happen.
    // And the shape of the bug it fixed: no title may END on "Mac", which is
    // what reads as a truncated "Machine" under a button's ellipsis. `endsWith`
    // rather than `contains`, because "This Machine" contains "Mac" — that
    // prefix relationship IS the misreading, so the check has to be about
    // where the string stops.
    for (const screen of NODE_SCREEN_IDS) {
      expect(screenTitle(screen).endsWith("Mac"), screen).toBe(false);
    }
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
