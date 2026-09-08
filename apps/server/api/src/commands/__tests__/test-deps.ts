import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDeps } from "../configure.js";

/**
 * Shared injected-deps harness for the `init`/`configure` command tests: a
 * fresh temp configDir, collecting log/error sinks, a scripted prompt, and a
 * tmux-present `which` by default (tests flip the pieces they care about).
 * Nothing here touches `process.env` — commands read ONLY through `deps`.
 */
export interface TestHarness {
  deps: CommandDeps;
  /** Fresh temp dir passed as `deps.configDir` (exists, empty). */
  dir: string;
  /** Lines passed to `deps.log`. */
  out: string[];
  /** Lines passed to `deps.error`. */
  err: string[];
  /** `[question, default]` pairs in call order (empty when nobody was asked). */
  prompts: [string, string][];
}

export function makeDeps(overrides: Partial<CommandDeps> & { answers?: (string | null)[] } = {}): TestHarness {
  const { answers: scripted, ...rest } = overrides;
  const answers = [...(scripted ?? [])];
  const dir = mkdtempSync(join(tmpdir(), `subshell-cmd-test-${process.pid}-`));
  const out: string[] = [];
  const err: string[] = [];
  const prompts: [string, string][] = [];
  const deps: CommandDeps = {
    prompt: (question, def) => {
      prompts.push([question, def]);
      if (answers.length === 0) throw new Error(`unexpected prompt '${question}' — no scripted answers left`);
      return answers.shift() as string | null;
    },
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    configDir: dir,
    env: {},
    which: () => "/usr/bin/tmux",
    isTTY: false,
    ...rest,
  };
  return { deps, dir, out, err, prompts };
}
