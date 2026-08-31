import { wsOrigin } from "@/lib/instance-url";
import type { ProbeDeps } from "@/lib/probe";

/** ~3 s socket settle (spec §Error handling "open /ws with a ~3 s timeout"). */
const PROBE_TIMEOUT_MS = 3000;

/**
 * The real transport behind probeInstance — exported so Settings re-probes.
 * Lives outside src/lib's pure core by necessity (it touches fetch/WebSocket);
 * it imports no native module, so the file stays testable on Bun.
 */
export function makeProbeDeps(): ProbeDeps {
  return {
    fetchSetupStatus: async (origin) => {
      // Timer-race instead of AbortSignal.timeout: RN's fetch types and the
      // DOM lib's AbortSignal disagree, and an abandoned fetch is harmless.
      const res = await Promise.race([
        fetch(`${origin}/api/setup/status`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
      ]);
      if (!res.ok) throw new Error(`probe status ${res.status}`);
      return (await res.json()) as { needsSetup: boolean };
    },
    openProbeSocket: (origin) =>
      new Promise<{ opened: boolean; closeCode: number | null }>((resolve) => {
        let settled = false;
        const done = (r: { opened: boolean; closeCode: number | null }) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        // Bogus ids → the server answers 4001/4004 IF upgrades tunnel at all.
        const ws = new WebSocket(`${wsOrigin(origin)}/ws?session=probe&token=probe`);
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* already dead */
          }
          done({ opened: false, closeCode: null });
        }, PROBE_TIMEOUT_MS);
        ws.onopen = () => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /* already dead */
          }
          done({ opened: true, closeCode: null });
        };
        ws.onclose = (e) => {
          clearTimeout(timer);
          done({ opened: false, closeCode: e.code ?? null });
        };
        ws.onerror = () => {
          /* every error is followed by a close; onclose settles */
        };
      }),
  };
}
