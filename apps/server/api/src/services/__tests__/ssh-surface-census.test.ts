import { describe, expect, it } from "bun:test";
import { SSH_PANE_SURFACES } from "@/services/ssh/ssh-policy.js";

/**
 * The SSH surface CENSUS (spec §2: the surface list is frozen so "did we gate
 * it?" is a census, not a memory test; review I-4).
 *
 * Every member of the frozen {@link SSH_PANE_SURFACES} must appear as a
 * quoted literal at a PRODUCTION gate call site (the surfaces are passed to
 * `#sshGate` / `gatePaneSurfaceFor` / the policy arms exactly as a string
 * literal, so a rename or a removed gate breaks this test). A member with
 * zero call sites fails - and there is no exception list any more:
 *
 * - `attach_mint`: wired in `api/ws-token.route.ts` (the mint-time census;
 *   Gate C minor 5 removed it from PENDING_WIRING once the coordinator's
 *   hunk landed - a stale pending entry is exactly the drift this census
 *   exists to catch, and a surface that is wired must not be excused).
 * - `live`: wired in `ws/live-publisher.ts` (review I-5: the publisher
 *   asks the policy for the owner instead of narrowing structurally).
 * - `capture` / `prompt`: wired in `subshells.service.ts` - the dedicated
 *   screens door (`previewsFor`) asks `capture`, the restart-prompt path
 *   asks `prompt` before any effect.
 */

/** Files that own gate call sites (service surfaces + the ws doors + the mint). */
const PRODUCTION_SOURCES = [
  new URL("../../services/subshells.service.ts", import.meta.url),
  new URL("../../services/pane-ssh-gate.ts", import.meta.url),
  new URL("../../ws/live-publisher.ts", import.meta.url),
  new URL("../../ws/attach-resolve.ts", import.meta.url),
  new URL("../../api/subshells/ssh-pane-ops.route.ts", import.meta.url),
  new URL("../../api/ws-token.route.ts", import.meta.url),
];

/**
 * Surfaces whose call site has NOT landed yet. EMPTY by design: the day a
 * surface moves here, the entry must name the workstream hunk that lands it
 * (a nameless pending excuse is the drift rule), and nothing may live here
 * across a release.
 */
const PENDING_WIRING: Record<string, string> = {};

describe("SSH surface census", () => {
  it("every frozen surface has a production call site (or a named pending wiring)", async () => {
    const corpus = await Promise.all(PRODUCTION_SOURCES.map((f) => Bun.file(f).text()));
    const missing: string[] = [];
    for (const surface of SSH_PANE_SURFACES) {
      const called = corpus.some((text) => text.includes(`"${surface}"`));
      if (called) continue;
      if (PENDING_WIRING[surface]) continue;
      missing.push(surface);
    }
    // The failure list names exactly what has NO gate and NO excuse.
    expect(missing).toEqual([]);
    // And the census is actually populated: a frozen list nobody consults
    // would pass the loop vacuously only if every entry were pending.
    const wired = SSH_PANE_SURFACES.filter((s) => corpus.some((t) => t.includes(`"${s}"`)));
    expect(wired.length).toBeGreaterThanOrEqual(SSH_PANE_SURFACES.length - Object.keys(PENDING_WIRING).length);
  });

  it("the pending-wiring map never drifts from the frozen list", () => {
    for (const surface of Object.keys(PENDING_WIRING)) {
      expect((SSH_PANE_SURFACES as readonly string[]).includes(surface)).toBe(true);
    }
  });
});
