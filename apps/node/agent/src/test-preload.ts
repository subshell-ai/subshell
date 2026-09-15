import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every `bun test` in this package gets a throwaway agent home so no suite can
// read or write the developer's real ~/.config/subshell. Tests that care
// about a pristine (empty) home call newHome() themselves; this only guarantees
// nothing lands in $HOME.
process.env.SUBSHELL_CONFIG_HOME = mkdtempSync(join(tmpdir(), "subshell-test-"));
process.env.SUBSHELL_TEST_MODE = "1";
// The enroll happy-path tests run against a local fake control plane; requiring
// a tmux server on the test host would make the suite host-dependent. The
// tmux-absent path is covered explicitly (cli test clears this + PATH).
process.env.SUBSHELL_CLIENT_SKIP_TMUX_CHECK = "1";
// OFF, always. `releaseApiUrl()` treats UNSET as the project's real GitHub API
// — the right default for an operator and the wrong one for a suite, which
// would then resolve against whatever is published today, slowly and flakily,
// from CI. Empty is the air-gapped spelling, so every release path refuses by
// name instead. A test that wants the behaviour sets the variable itself and
// restores it (`update.test.ts`'s `releaseApiUrl` case does exactly that), and
// the download tests point it at a loopback `Bun.serve`. This is the same
// closure `e2e/stack.ts` got on 2026-09-15 and the server's `IS_TEST` has had
// all along.
process.env.SUBSHELL_RELEASE_URL = "";

/** Fresh empty directory, installed as SUBSHELL_CONFIG_HOME; returns its path. */
export function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-test-"));
  process.env.SUBSHELL_CONFIG_HOME = dir;
  return dir;
}
