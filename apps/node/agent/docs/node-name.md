# The node's name is decided HERE: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## The node's name is decided HERE (revamp 2026-09-17)

The Add-node dialog used to open with a "Node name" field. Its text became only the
SETUP KEY's `label`: `install.sh` runs `subshell setup` with no `--name`, so the node
was named by its own hostname whatever had been typed, and the label was a name nobody
could connect to a machine. The field, the `label` column and the guess are all gone;
the question now sits where the answer is.

- **`setup` asks.** `NAME_QUESTION` ("Name this node"), prefilled with `os.hostname()`
  so Enter keeps the machine's own name, validated by `nodeNameProblem`, which is
  `normalizeNodeName` from `@internal/subshell-protocol`, the control plane's own rule,
  so the prompt cannot accept what enroll would refuse. A cancel stops the whole verb
  (exit 1, nothing enrolled, the single-use key is unspent) because a name nobody chose
  is worse than no node.
- **`enroll` requires `--name`.** It is the primitive that asks nothing of anyone, so a
  nameless `enroll` is a usage error (exit 2) naming the flag: before tmux, before the
  identity, before the network. Both verbs share one rule, and the name that leaves
  this binary is the normalized one, so the plane stores what the operator meant
  whatever typed it.
- **A prompt needs a terminal.** `--yes`, `--json` and a piped install cannot answer, so
  `setup` requires `--name` under any of them; the install one-liner's spelling is
  `curl … | SUBSHELL_NODE_NAME="mac mini" bash` (argv cannot cross a pipe, the same
  reason `SUBSHELL_DATA_DIR` and `SUBSHELL_NO_SERVICE` exist). Without that knob and
  without `--name`, the script's `exec </dev/tty` reattach is what lets the question be
  asked at all, which is why it sits BEFORE the final `setup` line and why a CI pipe,
  which has no `/dev/tty`, must name the machine explicitly.
- **`config.json`'s `name` is a local echo of what enroll sent.** The plane owns the
  row afterwards (`PATCH /api/nodes/:id`), which is why `configure` still takes no
  `--name` (see `apps/node/agent/docs/repointing.md`); that rule is unchanged and now reads more clearly: the
  NAME is chosen at enroll, the RENAME is the plane's.
