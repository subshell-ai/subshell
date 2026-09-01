import { run } from "./cli.js";

/**
 * Entry point for the compiled `mote-agent` binary (and `bun src/main.ts` in
 * dev). Deliberately pulls in ONLY cli/enroll/config/identity — the agent is a
 * standalone client of the control plane and never imports backend modules.
 * No top-level await: `bun build --compile --bytecode` rejects it.
 */
run(process.argv.slice(2))
  .then((result) => {
    if (result.out) process.stdout.write(result.out);
    if (result.err) process.stderr.write(result.err);
    process.exit(result.code);
  })
  .catch((err: unknown) => {
    // run() is total for expected failures; anything here is a bug — show it raw.
    process.stderr.write(`mote-agent: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
