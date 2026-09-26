# Issue templates (2026-09-25)

## The problem

Issue #227 asks for GitHub issue templates so filed feedback arrives with the
facts needed to act on it. The two feedback issues before it show the gap
concretely. #225 buried the decisive facts: the download stall reproduced only
on an Intel MacBook, and the node-connect failure hinged on a `nodeWsUrl` set
to localhost surviving a reset and overriding `serverUrl`, learned only after
an exact sequence of installs. #226 is pure wish-list feedback with no place to
live. A guided form asks for the component, the machine, the sequence, and the
config, so the next report arrives answerable.

## Decisions taken in the design conversation

- **Issue templates, not PR templates** (operator call 2026-09-25): #227 names
  issue templates, and bug / feedback / question are filer categories.
- **Questions stay issues**: GitHub Discussions is off and stays off; the
  question form files a real issue tagged `question` (operator call 2026-09-25).
- **Labels ride the templates**: kind labels pre-apply from the form, and triage
  `area:` labels are created on the repo for manual application (operator call
  2026-09-25).
- **YAML forms over markdown**: forms enforce required fields in the UI and
  render dropdowns; markdown templates enforce nothing, which is how a
  #227-shaped meta-issue becomes someone's bug report. A hybrid fallback file
  adds a path nobody picks.
- **Blank issues off**: the four forms partition the space (docs form added by
  operator request 2026-09-25, after the first three were reviewed).

## The mechanism

### The four forms, each field traced to a gap

`.github/ISSUE_TEMPLATE/bug-report.yml`, pre-label `bug`:

Rows are in shipped field order; the search prompt leads because a duplicate
caught before the writing starts never needs the other fields.

| Field | Why |
|---|---|
| Before you file: I have searched the existing issues for this (checkbox, required option) | One click that keeps #225/#226-shaped near-duplicates off the queue. |
| What happened? (textarea, required) | The report itself. Carries the pane-redaction warning: filers paste output here first. |
| Steps you took, in order (textarea, required) | #225's value was the exact sequence: install server, hit create account, reset, install client, node silently fails. |
| What you expected instead (textarea, required) | Absent from #225; turns a narrative into a diff. |
| Where did you do this? (dropdown: macOS (Apple silicon), macOS (Intel), Linux, Windows, Other) | "AMD MacBook" was the one decisive fact of the stall report. |
| Which parts are affected? (checkboxes, required: Control plane / server, Subshell Server desktop app, Subshell Client desktop app, CLI and node agent (subshell), Web UI in a browser, Mobile app, Website / docs, A harness plugin, Not sure) | The monorepo ships seven surfaces; untriaged issues cannot say which. |
| Version (input, optional) | App About screen or `subshell-server version`. |
| Config or log excerpts (textarea, optional) | #225 turned on config values. Carries an in-form warning to redact tokens, passwords, and anything typed into a pane, because pane logs are the most sensitive artifact the product writes (`security-context.md`). |
| Additional context (textarea, optional) | The free space the guards cannot ask for; carries the redaction warning too. |

`.github/ISSUE_TEMPLATE/feedback.yml`, pre-label `feedback`, deliberately three
fields so feedback stays as easy to give as #226 was:

| Field | Why |
|---|---|
| What would make Subshell better for you? (required) | #226: one installer, client that runs a node and keeps the UI, Grok Build harness. |
| What are you doing today because of this? (textarea, optional) | Captures the job-to-be-done behind the ask. |
| Which part does this touch? (checkboxes, optional: Whole product plus the same surface list, minus Not sure) | Route without a report. |

`.github/ISSUE_TEMPLATE/question.yml`, pre-label `question`: an intro alert
routes "Not working? The bug report form asks for exactly what we need to fix
it; questions land here and get answered on the thread." Two fields: what you
are trying to do (required), and what you have read or tried so far (optional,
docs links welcome).

`.github/ISSUE_TEMPLATE/docs.yml`, pre-label `documentation` (GitHub's default,
already on the repo): page or section (input, optional, docs URL or where the
answer should live), what is wrong or missing (textarea, required), what you
expected to find (textarea, optional, proposed wording usually ships close to
verbatim).

All shipped strings follow the em-dash-free voice rule and the two-sentence
explanation cap (`docs/design-system.md` voice notes).

`config.yml` sets `blank_issues_enabled: false`.

### Labels

GitHub's YAML forms cannot map checkboxes to labels, so forms pre-apply only
the kind label and area labels stay a triage act read off the checkboxes.
Created with `gh label create`: `feedback` (new), plus `area: server`,
`area: desktop`, `area: node-agent`, `area: web-ui`, `area: mobile`,
`area: website`, `area: harness`. `bug`, `question`, and `documentation`
already exist on the repo and are reused.

## Rollout and verification

Branch `feat/issue-templates`, this spec plus the four YAML files, PR reviewed
per `.claude/rules/code-review.md`. GitHub renders templates only from the
default branch, so verification after merge: `gh label list` shows the new
labels, and `https://github.com/subshell-ai/subshell/issues/new` shows the
four-option picker with required-field guards working. A local YAML parse
check runs before push.

Out of scope: the defects #225 reported (the `nodeWsUrl` precedence bug, the
reset path) stay separate follow-up issues.
