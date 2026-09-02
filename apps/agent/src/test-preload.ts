import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every `bun test` in this package gets a throwaway agent home so no suite can
// read or write the developer's real ~/.config/subshell-agent. Tests that care
// about a pristine (empty) home call newHome() themselves; this only guarantees
// nothing lands in $HOME.
process.env.MOTE_AGENT_HOME = mkdtempSync(join(tmpdir(), "subshell-test-"));
process.env.MOTE_TEST_MODE = "1";
// The enroll happy-path tests run against a local fake control plane; requiring
// a tmux server on the test host would make the suite host-dependent. The
// tmux-absent path is covered explicitly (cli test clears this + PATH).
process.env.MOTE_AGENT_SKIP_TMUX_CHECK = "1";

/** Fresh empty directory, installed as MOTE_AGENT_HOME; returns its path. */
export function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-test-"));
  process.env.MOTE_AGENT_HOME = dir;
  return dir;
}
