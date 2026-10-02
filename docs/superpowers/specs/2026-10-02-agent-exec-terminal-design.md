# Agents run one command in a terminal pane and get the exit code back

Date: 2026-10-02. Status: approved by the operator in dialogue (the rulings
below are quoted at their decision points). Builds on
`2026-10-01-mcp-terminal-sessions-design.md` (the byte cursor and presetless
terminal launch are this feature's floor; it adds its own branch on top).

## Summary

An agent can already type into any pane (`send_to_subshell` rides the tmux
keystroke seam, which does not care what runs in the pane) and can read a
terminal pane's log with a lossless byte cursor (spec 2026-10-01). What
neither leg provides is completion: the log is a byte stream with no command
boundaries, so a "run a build, read the result" loop cannot tell done from
still-printing from stuck-at-a-prompt, and exit codes never surface. This
spec adds one verb that owns that protocol: `POST /api/subshells/:id/exec`
types a command into a terminal pane's shell, waits for a sentinel line the
shell itself prints, and answers with the command's output and exit code.
Exposed through MCP as `exec_in_terminal`. It adds zero node-protocol surface
(`log_read` and the input seam are already in the shipped agent), zero new
authorization, and leaves the terminal pane "dumb" on purpose: the sentineling
is done by the plane, the way every existing seam already types on the pane's
behalf.

The alternative shapes were considered and ruled out in dialogue: leaving the
sentinel to agent convention (works, but is discipline, not machinery),
output-quietness as the completion signal (a 90-second sleep looks done at the
second of silence; a hung prompt looks done forever; it is only honest as a
pre-flight check, which is where this spec uses it), and server-side shell
integration markers (injected rcfile or OSC 633; a strictly stronger contract
that also catches human-typed commands, but it mutates the shell environment
inside the pane, and it is a separate spec decision, not a dependency).

## Operator rulings (2026-10-02)

1. Method, after the approaches were laid out: "take to a proper design using
   what you think is the best method", accepting the recommended exec verb.
2. Timeout, asked as report-only vs opt-in Ctrl-C vs always-interrupt:
   "Report only, never touch the pane (Recommended)". A timed-out command
   keeps running; the human's pane is untouched; the agent decides what next.
3. Busy pane, asked as quiet-check vs always-type vs check-plus-force:
   "Quiet-check, refuse while producing (Recommended)". No force flag in v1;
   a false refusal costs one retry, a false accept corrupts a running program.
4. Standing process ruling (2026-10-02): nothing merges until the operator has
   verified behavior. This spec ships to a branch and a PR, like everything
   else now.

## 1. The sentinel protocol

The plane composes both keystrokes and the entire waiting logic. Nothing
about it is visible to the node.

**Token and lines.** Each exec draws a fresh 16-hex-character random token
`T`. After a pre-flight quiet check (§2), the service records the pane log's
current size as `startByte`, then types two separate inputs, each with its
own Enter, through the existing `sendInput` seam:

1. `command` exactly as the caller gave it;
2. a lone line: `printf '__xcomm_<T>_DONE rc=%s\n' "$?"`

Two sends, not one `;`-joined line, so a multi-line command (a paste with
embedded newlines, a heredoc) still runs the marker only after the shell
returns. `$?` is expanded when the shell parses the printf line, which is
exactly when the user's command has just finished, so `rc` is the command's
status. If a running program consumes stdin (an interactive `cat`, a REPL),
it swallows both lines and no sentinel appears; the call times out honestly,
which is the same failure a human's blind typing produces, now named.

**Recognition.** The answer line, after the existing ANSI strip, is matched
with the anchored test `^__xcomm_<T>_DONE rc=([0-9]+)$`. The *echo* of the
printf line (what the terminal shows as the command was typed) cannot
false-match: it carries quotes and a literal `$?`, and it sits behind prompt
characters, while the match is anchored on a whole stripped line. Prompt
themes are irrelevant because `cursorLinesFromWindow` strips before the split.

**Output.** The result's `output` is everything the pane wrote from
`startByte` up to (not including) the sentinel line: it includes the shell's
echo of the typed command, and that is deliberate, because the pane's truth
is what the slice shows and trimming heuristics would be a second, guessing
implementation. Paging uses the spec 2026-10-01 reader (`readLogWindow` local
and remote, `LOG_MAX_WINDOW_BYTES` windows, line-aligned `nextByte`) in a
loop until recognition or the deadline. `output` keeps the last
`EXEC_MAX_OUTPUT_BYTES` (256 KiB, the log-tail precedent) of that slice; past
the cap the head is dropped and `truncated: true`. The final `nextByte` is
the offset after the sentinel line, so a follow-up `read_subshell_log`
resumes exactly where exec stopped.

## 2. The REST verb and its gates

`POST /api/subshells/:id/exec` (route file beside the input route, same
directory): body `{command, timeout_ms?}`.

Gates, in the order the input route already applies them: `requirePerm
("subshells","write")`; the per-subshell `edit` grant (bearer follows the
existing switch-off; a `view` grantee cannot type, and exec is typing with a
receipt); foreign row 404; the row's two facts `running` AND `alive` else the
input route's clean 409; offline node its existing 409. Then one new gate by
name: the pane's harness must resolve to a plugin of type `terminal`. An
agent-harness pane's keystrokes feed the agent's own input box, so exec
refuses with 400 `EXEC_TERMINAL_ONLY` before anything is typed; Inject-prompt
gates on liveness for the mirror-image reason.

Pre-flight quiet check: the log's `size` (local `stat`; remote the window
answer's size field, since `log_read` carries no mtime) must be unchanged
across two probes at least `EXEC_QUIET_MS` (1000 ms) apart. A pane that
printed during the window answers 409 `EXEC_PANE_BUSY` with nothing typed.

Concurrency: an in-flight lease keyed by subshell id, the
`RESTART_IN_FLIGHT` precedent. A second exec on the same pane is 409
`EXEC_IN_FLIGHT`; interleaved sentinel typing on one shell would corrupt both
calls, and the lease makes that impossible rather than unlucky.

Timeout: `timeout_ms` defaults to 30 000 and is clamped to [1000, 300 000]
(the update-command ceiling precedent; the channels long-poll proves
minute-scale synchronous HTTP is an accepted regime in this codebase). On
timeout the call returns `status: "timed_out"` with the output slice so far
and the current cursor; it types nothing further and sends no signal (ruling
2 above). Timeout is a field of a successful answer, not an HTTP error, so a
merely slow build never rides a client's error path.

Response: `{status: "completed" | "timed_out", exit_code, output, truncated,
next_byte}`; `exit_code` is null when `status` is not `completed`. No audit
row, following the input route's precedent: exec is typing, and the fact that
typing happened is already recorded by the pane's own log.

## 3. The MCP tool

`exec_in_terminal` is registered in `packages/mcp-core` from a NEW
`terminal-tools.ts` (the `transfer-tools.ts` reasoning: `subshell-tools.ts`
is at 439 lines, and the terminal family deserves its own seam). The Zod
schema is a named constant per the house rule: `{subshell_id, command,
timeout_ms?}`. The handler is a thin POST; every protocol decision lives
server-side so the CLI or desktop can ride the same verb later without a
second implementation. The tool returns the server's JSON result as text.

The tool description carries the boundary the machinery cannot enforce, in at
most three sentences: it runs one shell command in a terminal pane and
returns its output and exit code once the sentinel confirms; it refuses
without typing while the pane is producing output, and on timeout it touches
nothing and reports what printed; interactive programs (password prompts,
editors, TUIs) are out of scope and belong to `send_to_subshell` plus
`read_subshell_log`.

`describeToolError` gains three named-code branches, each naming the remedy
for an agent: `EXEC_PANE_BUSY` ("the pane is producing output; wait or read
it first, nothing was typed"), `EXEC_TERMINAL_ONLY` ("exec types shell
commands into terminal panes; this pane runs a harness, use send_to_subshell
to type into it"), `EXEC_IN_FLIGHT` ("another exec is waiting on this pane;
retry after it finishes"). The codes ride the wire under their own names,
which is the `NODE_REQUIRED` family's rule, so the client-side branches are
exhaustive by construction.

Mechanics the implementation must re-pin deliberately: the tool-name set
assertion in `server.test.ts` (this branch's reality is S1's 20 tools plus
this one; once S2 merges the set also contains `transfer_files`, and
whichever of S2/S3 lands second carries the conflict, as already planned
between them), and the `SUBSHELL_MCP_INSTRUCTIONS` pinned 1200-character
budget, which any added guidance must fit inside or trim by name.

## 4. Docs, security note, changesets

- `apps/docs/content/docs/mcp/tools.mdx`: the new tool.
- The terminal-sessions guide page (S1's): one paragraph, exec vs the manual
  send/read loop.
- `docs/security.md` (pane logs & input section) and the matching rule-file
  line: exec rides the existing keystroke seam and the sentinel text lands in
  the pane's own log, which the accepted typed-input posture already covers;
  no new secret class is introduced (the sentinel is random noise, not data).
- Changesets: `@internal/server` and `@internal/mcp-core`, as the S1/S2
  changesets do.

## 5. Tests

- Pure helpers (`services/nodes/pane-exec.ts` owns sentinel compose/parse,
  the quiet-window decision, and the output slicing): the token cannot
  false-match the typed echo; rc parses; multi-window paging assembles
  long-output tail-first with `truncated`; a zero-output command still
  answers with its rc; the slice excludes the sentinel line and stops at it.
- Service tests both ways: against a real temp log file for the local path,
  and against a scripted node whose `log_read` answers carry the sentinel,
  asserting the typed argv byte-for-byte (both sends), that the quiet check
  refuses before any keystroke, that `EXEC_IN_FLIGHT` blocks a second exec,
  and that a timeout types nothing further.
- Route tests for the gate matrix: view 403, foreign 404, dead row 409,
  offline node 409, agent harness 400 `EXEC_TERMINAL_ONLY`, timeout clamp.
- MCP tests: fakeApi pass-through, the three `describeToolError` branches,
  the tool-name-set pin, the instructions-budget pin.
- No compiled-binary gate: nothing changes inside the shipped agent, so
  S2's archive-smoke precedent does not apply here.

## 6. Dependencies and order

S3 stacks physically on S1: the branch was cut from
`feat/mcp-terminal-sessions` and the cursor machinery is load-bearing for
§1. S1 itself awaits operator behavior-verification (standing rule: no
automatic merges). The merge order among S1, S2 (PR #317), and this branch is
the operator's call; the collision surface is unchanged (`packages/mcp-core`
registration and its two test files), and whichever pair lands second carries
that conflict.
