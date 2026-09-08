import { describe, expect, it } from "bun:test";
import { planeCoherence } from "@/lib/plane-coherence";

/**
 * This app holds TWO control-plane addresses, and nothing used to hold them
 * together. `planeUrl` is what the plane window opens; the node's `serverUrl`
 * in `config.json` is what the daemon dials. `plane_url_from` falls back to
 * the second only when the first is unset — so once a preference exists, the
 * two drift freely, and the app can show you a plane at one address while this
 * machine talks to another. Neither surface named the difference.
 *
 * The rule these tests pin: say something ONLY when both addresses are known
 * and they disagree, and offer the fix in the direction that matches what the
 * user is looking at.
 */

describe("planeCoherence", () => {
  it("says nothing when the two addresses agree", () => {
    expect(planeCoherence("https://subshell.example", "https://subshell.example")).toBeNull();
  });

  it("reports a divergence naming BOTH addresses, so neither has to be guessed", () => {
    const result = planeCoherence("https://new.example", "http://localhost:3080");
    expect(result).not.toBeNull();
    expect(result?.planeUrl).toBe("https://new.example");
    expect(result?.nodeServerUrl).toBe("http://localhost:3080");
    expect(result?.message).toContain("https://new.example");
    expect(result?.message).toContain("http://localhost:3080");
  });

  /**
   * A trailing slash is not a divergence. `validate_server_url` and the CLI's
   * `normalizeServer` both strip them, but `planeUrl` can predate either — and
   * warning about two spellings of one address teaches the user to ignore the
   * warning.
   */
  it("ignores a trailing-slash-only difference", () => {
    expect(planeCoherence("https://subshell.example/", "https://subshell.example")).toBeNull();
    expect(planeCoherence("https://subshell.example", "https://subshell.example///")).toBeNull();
  });

  it("is case-insensitive about the host, which DNS is too", () => {
    expect(planeCoherence("https://Subshell.Example", "https://subshell.example")).toBeNull();
  });

  it("does not treat a path difference as the same address", () => {
    expect(planeCoherence("https://subshell.example/a", "https://subshell.example/b")).not.toBeNull();
  });

  /**
   * One address known is not a conflict. An un-enrolled client has no
   * `serverUrl` at all, and a machine enrolled from the CLI has no stored
   * `planeUrl` until it opens one — both are ordinary states, and warning
   * about them would fire on a fresh install.
   */
  it("stays silent when either address is missing", () => {
    expect(planeCoherence(null, "https://subshell.example")).toBeNull();
    expect(planeCoherence("https://subshell.example", null)).toBeNull();
    expect(planeCoherence(null, null)).toBeNull();
    expect(planeCoherence(undefined, undefined)).toBeNull();
    expect(planeCoherence("", "")).toBeNull();
  });

  it("stays silent on an unusable stored value rather than blaming the node", () => {
    expect(planeCoherence("not a url", "https://subshell.example")).toBeNull();
  });
});
