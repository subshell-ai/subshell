/**
 * Emit one timestamped daemon log line. stdout: `mote-agent run` is a
 * foreground process and its operator (or the phase-3 service unit) reads
 * both streams anyway.
 *
 * Lives in its own module (moved out of daemon.ts) because the daemon sits at
 * the top of the import graph — anything downstream that needs to log would
 * otherwise close a cycle through it. daemon.ts re-exports it for its
 * historical importers.
 */
export function log(...parts: unknown[]): void {
  console.log(`[mote-agent ${new Date().toISOString()}]`, ...parts);
}
