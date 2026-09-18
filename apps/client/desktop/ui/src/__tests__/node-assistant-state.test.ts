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
    // "Register" is the first run's one press; "Enroll" is what the CLI calls
    // the same act and what this window still calls the DIFFERENT one — the
    // re-enrolment that mints a second node row and discards the node key. A
    // shared word on those two screens is how a person confirms the wrong one.
    expect(screenTitle("register")).not.toContain("Enroll");
    expect(screenTitle("enroll")).not.toContain("Register");
  });

  // The three service-state titles this used to pin went with the service
  // screen: a configured machine lands on `status`, whose heading is the
  // app's name and whose badge and problem line are what say which failure
  // it is looking at (`status-screen.test.tsx`).
  it("speaks the assistant's voice on the screens a person asks for", () => {
    expect(screenTitle("connect")).toBe("Connect to a Server");
    expect(screenTitle("enroll")).toBe("Enroll This Machine");
    expect(screenTitle("about")).toBe("About Subshell Client");
    expect(screenTitle("update")).toBe("Update Subshell Client");
  });

  it("never lets the APP's update and the AGENT's share a word", () => {
    // Two things on this machine can be out of date at once, and they are
    // replaced by different acts that cost different amounts: this screen
    // replaces the APPLICATION and relaunches it, while the status screen's
    // "Update the agent to X" replaces `~/.local/bin/subshell` through that
    // binary's own `update --from` and leaves the app alone. A title that said
    // only "Update" would be the one place a person could not tell which.
    expect(screenTitle("update")).toContain("Subshell Client");
    expect(screenTitle("update")).not.toContain("agent");
  });

  it("names the product rather than the computer, identically on both platforms", () => {
    // Two regressions pinned at once, both reported from a screenshot on
    // 2026-09-12. "Reset This Mac" reads as erasing the computer, which is
    // not remotely what this does; and a label ending on "Mac" reads as a
    // truncated "Machine", against a sibling string that really is "This
    // Machine". This is the one title that names no machine on any platform.
    expect(screenTitle("reset")).toBe("Reset this client");
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
    expect(serviceAction("no-agent")).toBeNull();
    expect(serviceAction("not-enrolled")).toBeNull();
  });
});
