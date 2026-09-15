import { describe, expect, it } from "bun:test";
import type { Permission, Probe } from "../lib/ipc";
import { DEV_BUILD_NOTE, permissionRows } from "../lib/permissions-model";

function probe(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.0.0",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: "/opt/homebrew/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: false,
    hostname: "mac",
    supervision: "service",
    supervisor: null,
    notificationPermission: "not-determined",
    photosPermission: "not-determined",
    ...over,
  } as Probe;
}

const row = (p: Probe, id: string, requesting = false) => {
  const found = permissionRows(p, requesting).find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

const ALL: Permission[] = ["not-determined", "denied", "authorized", "provisional", "unavailable"];

describe("permissionRows", () => {
  it("is the four things macOS will ask, in the order a first run meets them", () => {
    // The order is the point: it is the sequence of moments, not a ranking by
    // severity, so someone reading down the screen reads their own next hour.
    expect(permissionRows(probe(), false).map((r) => r.id)).toEqual(["notifications", "files", "photos", "login"]);
  });

  it("gives every row a label and a detail, whatever the states", () => {
    for (const notifications of ALL) {
      for (const photos of ALL) {
        for (const r of permissionRows(probe({ notificationPermission: notifications, photosPermission: photos }))) {
          expect(r.label.length, r.id).toBeGreaterThan(0);
          expect(r.detail.length, r.id).toBeGreaterThan(0);
        }
      }
    }
  });
});

/**
 * The one row with a button, and the reason every state needs its own line:
 * macOS asks exactly once. Offering "Allow" on a denied state is a button that
 * does nothing, and offering "Open System Settings" on an undetermined one
 * sends a person to a row that is not there yet.
 */
describe("the notifications row", () => {
  it("offers Allow only while macOS has not been asked", () => {
    const r = row(probe({ notificationPermission: "not-determined" }), "notifications");
    expect(r.action).toBe("allow");
    expect(r.state).toBe("pending");
    expect(r.suffix).toBe("");
  });

  it("is done and silent once allowed, provisionally or not", () => {
    for (const state of ["authorized", "provisional"] as const) {
      const r = row(probe({ notificationPermission: state }), "notifications");
      expect(r.state, state).toBe("done");
      expect(r.suffix, state).toBe("Allowed");
      expect(r.action, state).toBeNull();
    }
  });

  it("sends a denial to System Settings, never back to a prompt that will not fire", () => {
    const r = row(probe({ notificationPermission: "denied" }), "notifications");
    expect(r.state).toBe("failed");
    expect(r.suffix).toBe("Not allowed");
    expect(r.action).toBe("open-settings");
    expect(r.pane).toBe("notifications");
  });

  it("says a dev build cannot ask, and offers nothing there", () => {
    // The API aborts outside an `.app` bundle, so `tauri dev` answers
    // `unavailable` by construction. A button here would be a button that
    // cannot work on the only machine a developer is looking at.
    const r = row(probe({ notificationPermission: "unavailable" }), "notifications");
    expect(r.state).toBe("pending");
    expect(r.suffix).toBe("Unavailable in this build");
    expect(r.action).toBeNull();
    expect(r.detail).toContain(DEV_BUILD_NOTE);
  });

  it("goes active while the request is in flight, and keeps its button out of reach", () => {
    // The system sheet is modal to the app, so the row has to say something is
    // happening; `active` is the checklist's own spinner state.
    const r = row(probe({ notificationPermission: "not-determined" }), "notifications", true);
    expect(r.state).toBe("active");
    expect(r.action).toBe("allow");
  });

  it("ignores the in-flight flag for every other row", () => {
    for (const id of ["files", "photos", "login"]) {
      expect(row(probe(), id, true).state, id).toBe(row(probe(), id, false).state);
    }
  });
});

describe("the photos row", () => {
  it("never offers Allow, in any state", () => {
    // The system asks at the moment an image is picked, which is where Apple
    // puts it and where this app cannot intervene. Pre-empting it would be a
    // prompt raised for no reason the person can see.
    for (const state of ALL) {
      expect(row(probe({ photosPermission: state }), "photos").action, state).not.toBe("allow");
    }
  });

  it("reads the same words as the notifications row", () => {
    expect(row(probe({ photosPermission: "authorized" }), "photos").suffix).toBe("Allowed");
    expect(row(probe({ photosPermission: "denied" }), "photos").suffix).toBe("Not allowed");
    expect(row(probe({ photosPermission: "unavailable" }), "photos").suffix).toBe("Unavailable in this build");
    expect(row(probe({ photosPermission: "not-determined" }), "photos").suffix).toBe("");
  });

  it("offers System Settings once denied, since that is the only way back", () => {
    const r = row(probe({ photosPermission: "denied" }), "photos");
    expect(r.state).toBe("failed");
    expect(r.action).toBe("open-settings");
    expect(r.pane).toBe("photos");
  });
});

/**
 * The prompt this row explains is raised by whichever process runs `readdir`,
 * and that is not always this app — which is exactly the case that reads like
 * malware: a sheet naming a binary the person never typed.
 */
describe("the files row", () => {
  it("names the binary under a service and the app under app supervision", () => {
    expect(row(probe({ supervision: "service" }), "files").detail).toContain("subshell-server");
    expect(row(probe({ supervision: "app" }), "files").detail).toContain("Subshell Server");
  });

  it("does not name the CLI when the app is the one that will ask", () => {
    // "Subshell Server" CONTAINS neither spelling of the other, but the
    // hyphenated CLI name does appear inside nothing else — so this is the
    // assertion that catches an attribution that fell through to the default.
    expect(row(probe({ supervision: "app" }), "files").detail).not.toContain("subshell-server");
  });

  it("is a later moment, and says so without claiming a state it cannot read", () => {
    expect(row(probe(), "files").suffix).toBe("Asked later");
    expect(row(probe(), "files").state).toBe("pending");
  });

  it("always offers System Settings, because its state can never say when to", () => {
    // The dashboard raises this screen as the fix for a folder it could not
    // list, and this row's answer is unreadable by construction — so a button
    // gated on `denied` would be a button that never appears, and Fix… would
    // land on four lines of prose. Opening the pane always does something.
    for (const state of ALL) {
      const r = row(probe({ notificationPermission: state, photosPermission: state }), "files");
      expect(r.action, state).toBe("open-settings");
      expect(r.pane, state).toBe("files-and-folders");
    }
  });

  it("offers the same button under either supervision", () => {
    // Which process raises the prompt changes the SENTENCE, never the way back.
    for (const supervision of ["service", "app"] as const) {
      expect(row(probe({ supervision }), "files").pane, supervision).toBe("files-and-folders");
    }
  });
});

/**
 * Every row this screen is raised AS THE FIX for has something to press, in
 * the state the dashboard raises it in. This is the whole-screen version of
 * the rule each row states for itself: the notices in the SPA
 * (`components/desktop/permission-notice.tsx`) name three panes, and a Fix…
 * button that lands on a row with no control is a dead end that reads as a
 * broken app.
 */
describe("no notice dead-ends here", () => {
  it("gives the notifications row a control in both states the dashboard notices", () => {
    // `notifications-card.tsx` renders a notice on `denied` AND on
    // `not-determined` ("macOS has not been asked yet").
    expect(row(probe({ notificationPermission: "not-determined" }), "notifications").action).toBe("allow");
    expect(row(probe({ notificationPermission: "denied" }), "notifications").action).toBe("open-settings");
  });

  it("gives the photos row a control in the state the overlay notices", () => {
    expect(row(probe({ photosPermission: "denied" }), "photos").action).toBe("open-settings");
  });

  it("gives the files row one whatever this machine says", () => {
    expect(row(probe(), "files").action).toBe("open-settings");
  });

  it("names a pane on every row that offers to open one", () => {
    for (const notifications of ALL) {
      for (const photos of ALL) {
        for (const r of permissionRows(probe({ notificationPermission: notifications, photosPermission: photos }))) {
          if (r.action === "open-settings") expect(r.pane, r.id).not.toBeNull();
          else expect(r.pane, r.id).toBeNull();
        }
      }
    }
  });
});

describe("the login row", () => {
  it("says it is not a permission, and offers nothing", () => {
    // A banner is not a decision. The row exists because the banner appears
    // unannounced and reads as something having been done behind your back.
    const r = row(probe(), "login");
    expect(r.suffix).toBe("Not a permission");
    expect(r.action).toBeNull();
    expect(r.pane).toBeNull();
    expect(r.state).toBe("pending");
  });

  it("says the same thing whatever the two permission states are", () => {
    for (const state of ALL) {
      expect(row(probe({ notificationPermission: state, photosPermission: state }), "login")).toEqual(
        row(probe(), "login"),
      );
    }
  });
});
