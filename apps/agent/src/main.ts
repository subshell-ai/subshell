import { run } from "./cli.js";

/**
 * Entry point for the compiled `subshell` binary (and `bun src/main.ts` in
 * dev). Deliberately pulls in ONLY cli/enroll/config/identity — the agent is a
 * standalone client of the control plane and never imports backend modules.
 * No top-level await: `bun build --compile --bytecode` rejects it.
 */
run(process.argv.slice(2))
  .then((result) => {
    // A process-lifetime handle owns the process now (the `mcp` stdio
    // transport) — its resolve means "attached", not "done". Exiting here
    // kills the live connection (the T18 parity bug); fall through to idle.
    if (result.keepAlive) return;
    if (result.out) process.stdout.write(result.out);
    if (result.err) process.stderr.write(result.err);
    process.exit(result.code);
  })
  .catch((err: unknown) => {
    // run() is total for expected failures; anything here is a bug — show it raw.
    process.stderr.write(`subshell: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
