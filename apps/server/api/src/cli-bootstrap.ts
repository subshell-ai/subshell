import { dispatchCli } from "@/cli.js";
import { loadConfigEnv } from "@/config-env.js";

/**
 * Entry prelude — `index.ts` imports this FIRST, and the position is
 * load-bearing, not style (ESM evaluates every import before any body
 * statement, so the "first body statement" slot is already too late here):
 *
 * 1. `loadConfigEnv()` must hit `process.env` BEFORE `@/constants.js`
 *    evaluates — but THAT ORDER CANNOT BE SECURED FROM HERE: this module's
 *    first import is `@/cli.js`, whose graph pulls in `constants.js`, and ESM
 *    evaluates the whole graph before any module body runs. So the ordering
 *    guarantee lives in `constants.ts` itself, which applies the layer at the
 *    top of its own body (measured on macOS/launchd, 2026-09-07: the call
 *    below alone silently no-op'd the whole config.env layer). This call
 *    stays as the SETDEFAULT-idempotent belt for any graph that reaches a
 *    constants-free entry, and it is what keeps the documented precedence
 *    `process env > config.env > .env > defaults` true (as far as user code
 *    can: under `bun run`/compiled binaries, Bun preloads `.env` into
 *    `process.env` before ANY module runs — see the report note; the
 *    precedence is exact for the binary deployment, which ships no `.env`).
 * 2. This module uses NO top-level await. What SAFELY handles a subcommand
 *    is the pair pinned in `cli.ts`'s header — the synchronous
 *    `isCliEngaged()` boot gate plus the import-pure graph — not this
 *    module's await discipline (`mcp` suspends by design and is safe). The
 *    no-await rule stands anyway because suspension is otherwise invisible:
 *    measured on bun 1.4.0 (NOT spec behaviour — Node serialises module
 *    evaluation), any top-level await in the prelude — even `await null` —
 *    lets Bun evaluate all remaining imports and the entry body while the
 *    await is pending. Without that suspension, handled quick commands
 *    `process.exit` synchronously inside `dispatchCli` (house style); the
 *    `.then` below is a belt for stubbed-deps builds only.
 *
 * The boot path (no subcommand) is untouched: dispatch returns false
 * synchronously, this module finishes, and `index.ts` boots exactly as
 * before, with config.env values already in `process.env`.
 *
 * Under `bun test` this whole prelude is skipped (the same test-mode signal
 * `constants.ts` keys off): a suite importing the entry must neither read a
 * developer's config.env nor let `dispatchCli` swallow the runner's argv.
 */
if (process.env.SUBSHELL_TEST_MODE !== "1" && process.env.NODE_ENV !== "test") {
  loadConfigEnv();
  void dispatchCli(process.argv.slice(2)).then((handled) => {
    // Unreachable with default deps (the handler already exited); kept so a
    // stubbed-deps build behaves the contract way: handled ⇒ never boot.
    if (handled) process.exit(0);
  });
}
