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
 *    evaluates, so this module uses NO top-level await — but note what that
 *    mechanic is and is not. The entry graph IS inert at import time, by
 *    CONTRACT and under test: `@/db/index.js` opens SQLite lazily (dialect
 *    factory — first query) and `@/auth.js` builds better-auth lazily
 *    (`getAuth()`), so the graph a CLI run drags in touches no fs and no
 *    port (pinned by the import-purity tests). What keeps a suspended
 *    command from booting the server is the `isCliEngaged()` gate in
 *    index.ts, not this module's await discipline — `mcp` proves it, being
 *    long-running by design. The no-await rule still stands because
 *    suspension is otherwise invisible: measured on bun 1.4.0 (NOT spec
 *    behaviour — Node serialises module evaluation), any top-level await in
 *    the prelude — even `await null` — lets Bun evaluate all remaining
 *    imports and the entry body while the await is pending. With real deps
 *    `dispatchCli` still completes and `process.exit`s synchronously inside
 *    the call for every quick command (sync-exit is their house style).
 *    The `.then` is a belt for injected-deps/tests only.
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
