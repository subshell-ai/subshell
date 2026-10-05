import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { getHarness, TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";

/**
 * The LOCAL half of spec 2026-10-02 §5's "service tests both ways": this
 * drives `SubshellsService.execInTerminal` over a `local` row, so the whole
 * verb runs through `LocalLauncher` - the argv `tmux send-keys` seam for the
 * four frames, and a REAL pipe-pane log file for the cursor reads. The
 * scripted-node suite (`subshells-exec.test.ts`) covers the remote half
 * frame-for-frame; this file proves the composition is genuinely
 * launcher-agnostic: gates, lease, quiet probe, and sentinel wait are the same
 * code, and what they sit on here is tmux and bytes on disk.
 *
 * The pane's "shell" is a small eval loop, not an interactive bash, for two
 * honest reasons. It executes the typed lines and answers `$?` with the
 * previous line's real status (the `_prev` substitution) - exactly the
 * two-typed-lines contract §1 relies on, rc included, proven against this
 * shape by probe (echo answers 0, `false` answers 1) - and it avoids
 * readline, which this sandbox host has measured broken for INTERACTIVE
 * panes (2026-10-03: bash -i exits rc=0 after accepting one line, and even a
 * file-script bash's stdin reads EOF at once; an inline `-c` read loop is the
 * one shape that survives). On a healthy machine the exec machinery cannot
 * tell the two panes apart: it only ever sees bytes in the log.
 */
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ApiContext } from "@/lib/context.js";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { getLogger } from "@/utils/logger.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";

const subshells = new SubshellsRepository(db);
const tmux = new TmuxRunner();

const ownerEmail = `exec-local-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let ctx: ApiContext;

const id = `exec-local-${crypto.randomUUID()}`;
const socket = tmuxSocketFor(id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The pane's mini-shell (see the header): eval every typed line, with the
// literal `$?` in it rewritten to the PREVIOUS line's status before eval -
// `read` clobbers `$?`, so the substitution keeps §1's semantics honest.
// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the pane's shell, not a JS placeholder
const SHELLY = '_prev=0; while IFS= read -r line; do eval "${line//\\$\\?/\\$_prev}"; _prev=$?; done';

beforeAll(async () => {
  expect(getHarness("terminal")?.type).toBe("terminal"); // the gate's own truth, checked
  await setupAuthTables();
  await ensureLocalNode(db);
  const users = new UsersRepository(db);
  ownerId = await users.createUser({
    email: ownerEmail,
    name: ownerEmail,
    passwordHash: await hashPassword("exec-local-pass-1"),
    role: "user",
  });
  ctx = new ApiContext({ db, log: getLogger() });

  await subshells.create({
    id,
    userId: ownerId,
    presetId: null,
    harnessId: "terminal",
    name: "exec-local",
    workingDir: tmpdir(),
    tmuxSocket: socket,
    nodeId: LOCAL_NODE_ID,
    status: "running",
    alive: 1,
  });
  // The launcher's own mkdir, moved earlier: production creates the log dir
  // in `getDefaultLocalLauncher()`'s constructor at LAUNCH, but this test
  // pipes a hand-seeded pane, and a pipe-pane child whose target directory
  // is missing dies at attach with no error back to anyone - the log then
  // stays empty forever and the exec can only time out. (Observed 2026-10-03
  // against the suite's temp SUBSHELL_SERVER_DATA_DIR.)
  mkdirSync(dirname(subshellLogPath(id)), { recursive: true, mode: 0o700 });
  tmux.newSubshell(socket, id, tmpdir(), `/bin/bash -c '${SHELLY}'`);
  tmux.pipePane(socket, id, subshellLogPath(id));
  await sleep(400); // pipe attached before anything is typed
}, 30_000);

afterAll(async () => {
  tmux.killSubshell(socket, id);
  void tmux.cleanSocket(socket);
  await Bun.file(subshellLogPath(id))
    .unlink()
    .catch(() => {});
  await db.deleteFrom("subshells").where("id", "=", id).execute();
  await deleteUserByEmailOrId(ownerEmail);
});

describe("execInTerminal over the local launcher (spec 2026-10-02 §5, local path)", () => {
  const exec = (command: string) =>
    ctx.services.subshells.execInTerminal(ownerId, id, command, 15_000, {
      actor: "cookie",
      userId: ownerId,
      principal: `user:${ownerId}`,
      apiKeyId: null,
    });

  it("types through argv into a real pane, answers from the real log file, rc honest twice over", async () => {
    const answer = await exec("echo exec-local-marker");
    expect(answer.status).toBe("completed");
    expect(answer.exitCode).toBe(0);
    // The argv route is proven by the bytes on disk: the pane's tty echoed
    // the typed command, and the line's output followed it. Per §1 the
    // output slice deliberately includes the echo.
    const logText = await Bun.file(subshellLogPath(id)).text();
    expect(answer.output).toContain("echo exec-local-marker"); // the echo, typed through argv
    expect(answer.output).toContain("exec-local-marker\n"); // the real command output line
    expect(logText).toContain("exec-local-marker");
    // `nextByte` sits exactly after the sentinel answer line's newline: the
    // whole file decoded from the raw log is plain bytes here (no ANSI in
    // this pane), so the offset is recomputable against the answer match.
    const m = /__xcomm_[0-9a-f]{16}_DONE rc=0/.exec(logText);
    expect(m).not.toBeNull();
    // The raw line ends at the NEXT newline in the file, whatever the pty
    // put before it (onlcr makes it `\r\n` here - which is exactly why the
    // offset is scanned from the match, not computed as match-length + 1).
    const endLine = Buffer.byteLength(logText.slice(0, logText.indexOf("\n", m?.index ?? 0) + 1), "utf8");
    expect(answer.nextByte).toBe(endLine);

    // A non-zero rc rides the same path: the exit code is the pane's truth,
    // not the machinery's guess. (Lease is free: the first exec completed.)
    const fail = await exec("false # exec-local-rc1");
    expect(fail.status).toBe("completed");
    expect(fail.exitCode).toBe(1);

    // The cursor read resumes where exec stopped: a follow-up through the
    // same launcher sees exactly what the pane wrote after the sentinel.
    const after = await new LocalLauncher().readLogWindow(id, fail.nextByte, 4096);
    expect(new TextDecoder().decode(after.bytes)).not.toContain("__xcomm_");
  }, 30_000);
});
