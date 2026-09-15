import { describe, expect, it } from "bun:test";
import { LINGER_COMMAND, type PersistenceInput, persistence } from "@/lib/supervision";

/**
 * A machine that answers every question the good way: a systemd unit,
 * installed, armed, on a host whose user lingers. Each test below moves ONE
 * fact off this baseline, because the point of the model is that the four
 * facts are independent and the wrong combination of two of them is what
 * strands a headless server.
 */
const LINGERING: PersistenceInput = { manager: "systemd", installed: true, enabled: true, linger: true };

const at = (input: Partial<PersistenceInput>) => persistence({ ...LINGERING, ...input }, "blade-01");

describe("persistence", () => {
  it("answers the reboot question without mentioning logins, when nothing depends on one", () => {
    const { sentence, fix } = at({});
    expect(sentence).toContain("Comes back after a reboot");
    expect(sentence).toContain("without anyone logging in");
    expect(fix).toBeNull();
  });

  it("says a lingering-less systemd unit stops at LOGOUT, and offers the one command that changes it", () => {
    // The whole reason this model exists. `enabled` is true here — the old
    // "Start at login" switch was ON — and the server still disappears the
    // moment its owner logs out, which no surface in the app used to say.
    const { sentence, fix } = at({ linger: false });
    expect(sentence).toBe("Comes back when you log in, and stops when you log out.");
    expect(fix).toEqual({ kind: "linger", measured: true });
    expect(LINGER_COMMAND).toBe("loginctl enable-linger $USER");
  });

  it("phrases an unmeasured linger as a question about the machine, not as a fault", () => {
    // `null` is logind not answering — a container, no loginctl on PATH. The
    // remedy is the same; the confidence is not, and `measured` is what lets a
    // surface lead with "if nobody does" instead of stating a defect.
    const { sentence, fix } = at({ linger: null });
    expect(sentence).toContain("If nobody logs in to blade-01");
    expect(fix).toEqual({ kind: "linger", measured: false });
  });

  it("names the machine it was given, so a node's own name reaches the sentence", () => {
    expect(persistence({ ...LINGERING, linger: null }, "this machine").sentence).toContain(
      "If nobody logs in to this machine",
    );
  });

  it("offers enabling — never lingering — for a definition that starts nothing", () => {
    // Order matters: an unarmed unit's linger state is beside the point, and
    // offering `loginctl` to someone whose unit will not start at all sends
    // them to fix the wrong thing.
    const { sentence, fix } = at({ enabled: false, linger: false });
    expect(sentence).toBe("Will not come back after a reboot.");
    expect(fix).toEqual({ kind: "enable" });
  });

  it("offers nothing when the manager would not say whether it starts on its own", () => {
    const { sentence, fix } = at({ enabled: null });
    expect(sentence).toContain("did not say");
    expect(fix).toBeNull();
  });

  it("asks for an install before anything else, whatever the other facts claim", () => {
    const { sentence, fix } = at({ installed: false, enabled: null });
    expect(sentence).toBe("Started by hand. Nothing brings it back when it stops.");
    expect(fix).toEqual({ kind: "install" });
  });

  it("offers no linger remedy on macOS, where there is no such knob and none is missing", () => {
    // A LaunchAgent's lifetime IS the login session by design, so the honest
    // answer is the login sentence — not a caveat about a mechanism that
    // does not exist there.
    const { sentence, fix } = at({ manager: "launchd", linger: null });
    expect(sentence).toBe("Comes back when you log in to blade-01.");
    expect(fix).toBeNull();
  });

  it("describes the app-supervised server as what it is: alive for as long as the app", () => {
    const { sentence, fix } = at({ manager: "app", enabled: false, linger: null });
    expect(sentence).toContain("Runs while the Subshell Server app is open");
    expect(sentence).toContain("quitting the app stops it");
    // Ahead of `installed`/`enabled` on purpose: a machine running the server
    // as the app's child can also have a service definition sitting on disk,
    // and "will not come back after a reboot" would be answering about the
    // wrong one.
    expect(fix).toBeNull();
  });

  it("degrades to the weaker claim under a manager this build cannot name", () => {
    // win32, or a platform added later. Better a true vaguer sentence than a
    // confident one about a mechanism we have not checked.
    const { sentence, fix } = at({ manager: null, linger: null });
    expect(sentence).toBe("Installed and set to start on its own.");
    expect(fix).toBeNull();
  });
});
