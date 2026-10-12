import { runStaplerWithRetry } from "../packages/subshell-protocol/src/release-artifacts.js";

const dmgPath = process.argv[2];
if (!dmgPath) throw new Error("Usage: bun scripts/validate-dmg-staple.ts <dmg-path>");

// Validate the published image independently of the build's staple operation.
// Apple's ticket service can drop this connection too; never skip validation.
const valid = await runStaplerWithRetry("validate", dmgPath, {
  async runCapture(argv) {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  },
  log: console.log,
});
process.exitCode = valid ? 0 : 1;
