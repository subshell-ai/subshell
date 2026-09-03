import { dispatchCli } from "@/cli.js";
import { loadConfigEnv } from "@/config-env.js";

/**
 * Entry prelude — `index.ts` imports this FIRST, and the position is
 * load-bearing, not style (ESM evaluates every import before any body
 * statement, so the "first body statement" slot is already too late here):
 *
 * 1. `loadConfigEnv()` must hit `process.env` BEFORE `@/constants.js`
 *    evaluates — that module runs the dotenvx `.env` layer at ITS import
 *    time, and dotenvx only fills unset keys. config.env applied first is
 *    what makes the documented precedence `process env > config.env > .env >
 *    defaults` hold (as far as user code can: under `bun run`/compiled
 *    binaries, Bun preloads `.env` into `process.env` before ANY module
 *    runs — see the report note; the precedence is exact for the binary
 *    deployment, which ships no `.env`).
 * 2. A recognised subcommand must exit BEFORE the rest of the entry graph
 *    evaluates. That graph is NOT inert at import time: `@/db/index.js` now
 *    opens SQLite lazily (dialect factory — first query), but `@/auth.js`
 *    still builds better-auth at import, and the entry BODY would run the
 *    boot IIFE (migrations, listener). Measured on bun 1.4.0 (NOT spec
 *    behaviour — Node serialises module evaluation): any top-level await in
 *    the prelude — even `await null` — lets Bun evaluate all remaining
 *    imports and the entry body while the await is pending. Hence this
 *    module uses NO top-level await: `dispatchCli` with real deps completes
 *    and `process.exit`s synchronously inside the call for every handled
 *    command, so a CLI invocation never yields control. The `.then` is a
 *    belt for injected-deps/tests only, and the `isCliEngaged()` gate in
 *    index.ts covers future async commands (Task C's prompts).
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
