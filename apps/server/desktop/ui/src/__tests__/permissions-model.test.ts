import { describe, expect, it } from "bun:test";
import type { Permission, Probe } from "../lib/ipc";
import { DEV_BUILD_NOTE, type PermissionRequests, permissionRows } from "../lib/permissions-model";

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

const row = (p: Probe, id: string, requesting: PermissionRequests = {}) => {
  const found = permissionRows(p, requesting).find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

const ALL: Permission[] = ["not-determined", "denied", "authorized", "provisional", "unavailable"];

describe("permissionRows", () => {
  it("is the three things macOS will ask, in the order a first run meets them", () => {
    // The order is the point: it is the sequence of moments, not a ranking by
    // severity, so someone reading down the screen reads their own next hour.
    //
    // `login` left the list on 2026-09-17. It explained the "Background Items
    // Added" banner, which does appear, but it is not a permission: no state to
    // read, no pane to open, nothing to press, and therefore a row that could
    // never change — prose standing in the column a person reads for decisions.
    expect(permissionRows(probe()).map((r) => r.id)).toEqual(["notifications", "files", "photos"]);
  });

  it("pairs an `allow` button with its request exactly when it offers to ask", () => {
    // The renderer takes BOTH from the row, having hardcoded the notifications
    // label and handler back when that was the only askable row. A row that
    // says `allow` with no button data would render a fallback, and button
    // data on a row that cannot ask is a field nothing renders — either way
    // the two screens drift apart with no test in the middle. The label is
    // the uniform short "Allow" (operator's call, 2026-09-25), so it is the
    // REQUEST that identifies the sheet, and the walk checks that instead.
    for (const notifications of ALL) {
      for (const photos of ALL) {
        for (const r of permissionRows(probe({ notificationPermission: notifications, photosPermission: photos }))) {
          if (r.action !== "allow") {
            expect(r.allow, r.id).toBeNull();
            continue;
          }
          expect(r.allow, r.id).not.toBeNull();
          expect(r.allow?.label, r.id).toBe("Allow");
          // The row that offers to ask names the sheet it raises. `String()`
          // because `files` is not a `PermissionRequest` — the type already
          // says a row with nothing to ask cannot name one, and this checks
          // the two askable rows did not trade handlers.
          expect(String(r.allow?.request), r.id).toBe(r.id);
        }
      }
    }
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
 * The first of the two rows that can raise a sheet, and the reason every state
 * needs its own line: macOS asks exactly once. Offering "Allow" on a denied
 * state is a button that does nothing, and offering "Open Settings" on
 * an undetermined one sends a person to a row that is not there yet.
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
    const r = row(probe({ notificationPermission: "not-determined" }), "notifications", { notifications: true });
    expect(r.state).toBe("active");
    expect(r.action).toBe("allow");
  });

  it("ignores the PHOTOS in-flight flag, which is a different question", () => {
    // One flag per sheet. A shared flag would spin this row while the person
    // read the Photos sheet — two rows answering for one press.
    expect(row(probe({ notificationPermission: "not-determined" }), "notifications", { photos: true }).state).toBe(
      "pending",
    );
    for (const id of ["files"]) {
      expect(row(probe(), id, { notifications: true, photos: true }).state, id).toBe(row(probe(), id).state);
    }
  });
});

/**
 * The second row that can raise a sheet — and the reversal this row went
 * through, so its history belongs here rather than in a commit message.
 *
 * The row shipped with **no Allow, in any state** (spec 2026-09-14 § 9), on the
 * reasoning that the system asks in context at the moment an image is picked
 * and pre-empting that would be a prompt raised for no reason the person can
 * see. The operator asked for the button on 2026-09-17, and the reason it is
 * sound rather than merely possible is recorded in `desktop-core`'s
 * `request_photos`: the panel that normally raises this prompt is THIS app's
 * own image picker, so a sheet raised here arms the same TCC subject the picker
 * will hit. One question, asked where it can be explained — not a second door
 * to the same room.
 */
describe("the photos row", () => {
  it("offers Allow only while macOS has not been asked", () => {
    const r = row(probe({ photosPermission: "not-determined" }), "photos");
    expect(r.action).toBe("allow");
    expect(r.state).toBe("pending");
    expect(r.suffix).toBe("");
  });

  it("carries its own request, so a bare label cannot misroute the ask", () => {
    // The renderer used to hardcode "Allow notifications" for every `allow`
    // row. Two askable rows is exactly when that string becomes a lie. The
    // label is now the bare "Allow" (operator's call, 2026-09-25 — the row's
    // own label names the permission), so what keeps the anti-misroute real
    // is the REQUEST the row carries and the renderer's exhaustive Record
    // over it: the photos row can only reach the photos sheet.
    expect(row(probe({ photosPermission: "not-determined" }), "photos").allow).toEqual({
      label: "Allow",
      request: "photos",
    });
    expect(row(probe({ notificationPermission: "not-determined" }), "notifications").allow).toEqual({
      label: "Allow",
      request: "notifications",
    });
  });

  it("is done and silent once allowed", () => {
    // `Limited` — the person chose WHICH photos — arrives as `authorized` from
    // Rust, because the picker works either way and a notice would be false.
    const r = row(probe({ photosPermission: "authorized" }), "photos");
    expect(r.state).toBe("done");
    expect(r.suffix).toBe("Allowed");
    expect(r.action).toBeNull();
  });

  it("sends a denial to System Settings, never back to a prompt that will not fire", () => {
    // Once the answer is in, the pane is the ONLY way back — the button this
    // row has in `not-determined` is spent for good, which is the whole reason
    // the two actions are mutually exclusive rather than both offered.
    const r = row(probe({ photosPermission: "denied" }), "photos");
    expect(r.state).toBe("failed");
    expect(r.suffix).toBe("Not allowed");
    expect(r.action).toBe("open-settings");
    expect(r.pane).toBe("photos");
  });

  it("says a dev build cannot ask, and offers nothing there", () => {
    const r = row(probe({ photosPermission: "unavailable" }), "photos");
    expect(r.state).toBe("pending");
    expect(r.suffix).toBe("Unavailable in this build");
    expect(r.action).toBeNull();
    expect(r.detail).toContain(DEV_BUILD_NOTE);
  });

  it("goes active while its OWN request is in flight", () => {
    const r = row(probe({ photosPermission: "not-determined" }), "photos", { photos: true });
    expect(r.state).toBe("active");
    expect(r.action).toBe("allow");
    expect(row(probe({ photosPermission: "not-determined" }), "photos", { notifications: true }).state).toBe("pending");
  });

  it("says what asking now means, in the sentence rather than only the button", () => {
    // The old detail promised the prompt would arrive when an image was picked.
    // With a button on the row that is no longer the only story, and a person
    // who pressed Allow and then reads "asked when you attach one" learns that
    // the controls here do not do what they say.
    expect(row(probe({ photosPermission: "not-determined" }), "photos").detail).toContain("Asked now");
  });

  it("reads the same words as the notifications row", () => {
    expect(row(probe({ photosPermission: "authorized" }), "photos").suffix).toBe("Allowed");
    expect(row(probe({ photosPermission: "denied" }), "photos").suffix).toBe("Not allowed");
    expect(row(probe({ photosPermission: "unavailable" }), "photos").suffix).toBe("Unavailable in this build");
    expect(row(probe({ photosPermission: "not-determined" }), "photos").suffix).toBe("");
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
