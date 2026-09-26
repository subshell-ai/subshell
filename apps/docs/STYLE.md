# Subshell docs style guide

`apps/docs/AGENTS.md` stays the technical contract (vocabulary, MDX rules,
never invent). This guide governs prose. The reference models are the
Tailscale and NetBird documentation: plain, neutral, task-shaped, and
consistently slightly boring. Every page of this site should read as written
by the same careful team.

## What this voice is not

- Not performative. The writer knows the product and does not show off it.
  No clever headings, no slogan descriptions, no wit in warnings.
- Not staccato. Short punchy sentences in a row, three-word closers, and
  dramatic fragments read as synthetic. Rhythm comes from the content.
- Not anthropomorphic. Nothing hands over, owns a subject, notices, sits
  there, or walks in. Software is described by what it does.

## Sentences
- Average 15 to 25 words; split a sentence when it carries two ideas, not to
  look spare.
- Two or three consecutive sentences under eight words is a defect.
- One subordinate clause is normal; nested clauses get rewritten.
- A parenthetical must be needed to parse the sentence. Otherwise: own
  sentence, or link.
- An exception never shares a sentence with its rule. State the rule, then
  the exception as its own sentence, paragraph, or note.
- Steps are imperative ("Download the binary"). Facts are present tense ("the
  server revokes the token"). A step's result may use will or you can ("the
  device will appear in the dashboard"). History and release notes are past
  tense.
- Active voice with the actor named.
- The reader is "you". Advice may say "we recommend".

## Voice and headings
Plain and professional. Headings name the task or feature without dressing:
"Install the server", "Create the admin account", "What the status means",
"Prerequisites", "Notes", "Next steps". No wordplay, no sentence headings, no
colons doing stylistic work.

## Never appears here
- Dramatic fragments ("No config. No waiting.").
- Negative-contrast setups ("It's not magic, it's tmux"), except one per page
  where the reader may genuinely hold a wrong idea.
- Rule-of-three rhetoric and slogan-shaped frontmatter descriptions.
- Bold or italics used for emphasis or rhythm; bold stays for UI labels and
  the first mention of a term being defined.
- "Note that", "It's worth noting", "Simply", "Just", "Let's", "delve",
  "seamless", "robust", "leverage", "empower", "in a world of".
- Rhetorical questions, and "you might be wondering".
- An epigram closing a section or page.

## Warnings
A security warning or destructive-action notice survives every rewrite at
equal strength, phrased as fact plus consequence: "Anyone on your local
network who opens the page first can create the admin account." Never as
suspense.

## Truth
- Never invent a flag, default, version, or permission. Verify against code
  or the owning app's AGENTS.md.
- Keep qualifiers ("by default", "on Linux", "admin only"). Dropping one
  changes a fact.
- Quoted UI labels and error strings are transcribed exactly as the code
  prints them.

## Page shape
- Frontmatter: keep `title` and `description` (both required; quote YAML
  values containing ": "). A description is a plain one-liner.
- First paragraph: what this page covers, one to three neutral sentences. No
  throat-clearing, no "In this guide...".
- Where the page states requirements, collect them under **Prerequisites**
  before the steps.
- Ordered actions become numbered steps, one action each; when a step changes
  what the reader sees, the result follows as a plain sentence.
- A page may reorder its own content for clarity (caveats later, the working
  path first). Content never moves to another page, and no page is created,
  deleted, or merged.
- GitHub alerts: `warning` for data loss or security, `important` for what a
  reader must not miss, `note`/`tip`/`caution` sparingly. Every alert gets a
  neutral title.
- Tables for real lookups and comparisons only, never for prose lists.
- Link text is the destination page's title, never "here" or "this page".
  Links point at pages that exist.

## Calibration (before / after, from this site)

**Before (main's density):** Restart runs the same subshell again **in place**:
same id, same name, same place in every workspace. The pane is killed and
relaunched in the same folder with the same settings; its credentials rotate
(the old process's key dies with it and the new pane is launched with a fresh
one), and when the agent's conversation transcript survived, the restart
resumes that conversation rather than starting a new one.

**After (target):** Restart runs the same subshell again in place: same id,
same name, and the same position in every workspace. The pane is killed and
relaunched in the same folder with the same settings, and its credentials
rotate. If the agent's conversation transcript survived, the restart resumes
that conversation instead of starting a new one.

**Before (main's lede):** Subshell is a web application for creating, viewing,
and managing interactive **agent subshells**: real CLI coding agents (Claude
Code, OpenCode, Codex, Hermes, pi) running in tmux-backed terminal panes on
machines you own. Start an agent from the browser and walk away: the next
device you open (laptop, tablet, phone) shows the same live pane you can type
into, and a push reaches you when a decision is needed.

**After (target):** Subshell runs real CLI coding agents (Claude Code,
OpenCode, Codex, Hermes, pi) in terminal panes on machines you own. You can
start an agent from the browser, close the tab, and pick the same live session
back up from any other device. When the agent needs a decision, Subshell sends
you a push.

**Reference, the models (verbatim):** "Once you are authenticated, the device
will appear in the browser window." (Tailscale quickstart) "MagicDNS is
enabled by default, and we recommend you keep it enabled." (Tailscale)
"NetBird is open-source and can be self-hosted on your servers." (NetBird)
