import { createLogTransport, logger } from "../../log.js";

/** A captured log session: the lines emitted, and the undo. */
export interface LogCapture {
  /** Every line the agent logged while the capture was installed, in order. */
  lines: string[];
  /** Restores the real transport. Always call it — the logger is a singleton. */
  restore: () => void;
}

/**
 * Records the agent's log output by swapping the singleton's TRANSPORT, which
 * is LogLayer's own seam for this (`withFreshTransports`).
 *
 * Replaces spying on `console.log`. That spy asserted against an
 * implementation detail of the logging library — which console method a given
 * level happens to call — so routing `log()` through LogLayer silently blinded
 * eight tests at once: they went on passing their setup and failing their
 * assertions, with nothing pointing at the cause. Going through the transport
 * means these tests keep working across any future transport change, and they
 * observe the REAL formatted line rather than raw console arguments.
 *
 * @returns The recorded lines and a restore function
 */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" "));
  };
  // A console-shaped sink: spread the real one for the methods LogLayer does
  // not route to (`table`, `dir`, …), then capture every level onto one list —
  // the agent's output is ONE narrative and the tests assert on it in order.
  const sink = { ...console, log: record, info: record, warn: record, error: record, debug: record, trace: record };
  logger.withFreshTransports(createLogTransport(sink));
  return { lines, restore: () => logger.withFreshTransports(createLogTransport()) };
}
