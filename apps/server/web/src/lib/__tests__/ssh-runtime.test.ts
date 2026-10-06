import { describe, expect, it } from "bun:test";
import { destinationLabel, SshApiError, sshRuntimeErrorCopy } from "@/lib/ssh-runtime";

/**
 * The refusal copy table (design 2026-10-05 §7): every named code renders a
 * remedy, the runtime guidance names the BINARY only (never enrollment, never
 * `subshell setup`), and no sentence carries an em dash (the voice rule).
 */

describe("sshRuntimeErrorCopy", () => {
  const facts = { host: "app-02", machine: "Laptop" };
  const errFor = (sshCode?: string) => new SshApiError(409, "probe", { sshCode });

  it("names the binary install for a missing runtime", () => {
    const copy = sshRuntimeErrorCopy(errFor("runtime_missing"), facts);
    expect(copy).toContain("Subshell binary on app-02");
    expect(copy).not.toMatch(/setup|enroll/i);
  });

  it("names the updater for a protocol mismatch and the machine for host trust", () => {
    expect(sshRuntimeErrorCopy(errFor("session_protocol"), facts)).toContain("Update the Subshell binary");
    expect(sshRuntimeErrorCopy(errFor("host_key_changed"), facts)).toContain("Laptop");
  });

  it("names the machine for quota and the destination for connection failure", () => {
    expect(sshRuntimeErrorCopy(errFor("session_quota"), facts)).toContain("Laptop");
    expect(sshRuntimeErrorCopy(errFor("connection_failed"), facts)).toContain("app-02");
  });

  it("keeps the server message for unnamed refusals and stays within two sentences", () => {
    const named = new SshApiError(409, "the destination refused the session: something odd", {});
    expect(sshRuntimeErrorCopy(named, facts)).toContain("something odd");
    // Built by code point so this file carries no U+2014 byte itself: a repo
    // grep for the glyph stays honest, and the test still refuses the glyph.
    const emDash = String.fromCodePoint(0x2014);
    for (const code of ["runtime_missing", "session_protocol", "session_quota", "host_key_unknown"]) {
      const copy = sshRuntimeErrorCopy(errFor(code), facts);
      expect(copy).not.toContain(emDash); // the voice rule
      const sentences = copy.split(/[.!?](\s|$)/).filter((s) => s.trim() !== "");
      expect(sentences.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("destinationLabel", () => {
  it("omits the account when the connecting default applies", () => {
    expect(destinationLabel({ host: "10.0.0.2", port: 22, user: null })).toBe("10.0.0.2:22");
    expect(destinationLabel({ host: "10.0.0.2", port: 2222, user: "deploy" })).toBe("deploy@10.0.0.2:2222");
  });
});
