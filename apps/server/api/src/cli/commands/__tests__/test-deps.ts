import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InitDeps } from "../init.js";

/**
 * Shared injected-deps harness for the `init`/`configure` command tests: a
 * fresh temp configDir, collecting log/error sinks, a scripted prompt, and a
 * tmux-present `which` by default (tests flip the pieces they care about).
 * Nothing here touches `process.env` — commands read ONLY through `deps`.
 */
export interface TestHarness {
  deps: InitDeps;
  /** Fresh temp dir passed as `deps.configDir` (exists, empty). */
  dir: string;
  /** Lines passed to `deps.log`. */
  out: string[];
  /** Lines passed to `deps.error`. */
  err: string[];
  /** `[question, default]` pairs in call order (empty when nobody was asked). */
  prompts: [string, string][];
  /** `[question, default]` pairs passed to the yes/no seam, in call order. */
  confirms: [string, boolean][];
  /** How many times the service-install seam was invoked. */
  installs: number;
}

export function makeDeps(
  overrides: Partial<InitDeps> & { answers?: (string | null)[]; confirmations?: (boolean | null)[] } = {},
): TestHarness {
  const { answers: scripted, confirmations: scriptedConfirms, ...rest } = overrides;
  const answers = [...(scripted ?? [])];
  const confirmations = [...(scriptedConfirms ?? [])];
  const dir = mkdtempSync(join(tmpdir(), `subshell-cmd-test-${process.pid}-`));
  const out: string[] = [];
  const err: string[] = [];
  const prompts: [string, string][] = [];
  const confirms: [string, boolean][] = [];
  let installs = 0;
  /** One recorder behind BOTH text seams — the suites script one answer list. */
  const ask = (question: string, def: string): string | null => {
    prompts.push([question, def]);
    if (answers.length === 0) throw new Error(`unexpected prompt '${question}' — no scripted answers left`);
    return answers.shift() as string | null;
  };
  const deps: InitDeps = {
    prompt: ask,
    promptSync: ask,
    confirm: (question, def) => {
      confirms.push([question, def]);
      if (confirmations.length === 0) {
        throw new Error(`unexpected confirm '${question}' — no scripted confirmations left`);
      }
      return confirmations.shift() as boolean | null;
    },
    // Never the real installer: a unit test must not write a systemd unit or
    // a launchd plist into the developer's own home.
    installService: () => {
      installs++;
      return { code: 0, out: "Installed (stub).\n", err: "" };
    },
    hostname: () => "test-host",
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    configDir: dir,
    env: {},
    which: () => "/usr/bin/tmux",
    isTTY: false,
    ...rest,
  };
  return {
    deps,
    dir,
    out,
    err,
    prompts,
    confirms,
    get installs() {
      return installs;
    },
  };
}
