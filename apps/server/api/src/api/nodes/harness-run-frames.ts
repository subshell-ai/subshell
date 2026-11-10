/**
 * The pacing and bounds of a harness run's NDJSON answer, shared by the two
 * routes that stream one: `.../harnesses/:pluginId/install` and `.../update`.
 *
 * A remote run sends no line frames — its output arrives in the one terminal
 * answer — and Bun closes a response that writes nothing for 10 s (measured
 * against Bun 1.4.4, which answers a 12 s gap with ECONNRESET). Proxies have
 * their own idle deadlines too, so the beat is half Bun's window: two of them
 * per close, without turning the stream into chatter.
 */
export const HARNESS_RUN_HEARTBEAT_MS = 5_000;

/** Bound on node-provided error text relayed to the page; a wire frame can carry 1 MiB. */
export const HARNESS_RUN_ERROR_MAX = 4096;
