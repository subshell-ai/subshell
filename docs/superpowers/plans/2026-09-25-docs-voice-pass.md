# Docs voice pass implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development; steps
> are checkboxes.

**Goal:** Rewrite the prose of main's 72 docs pages in the Tailscale/NetBird
voice without touching the page set, URLs, or a single fact.

**Architecture:** STYLE.md is the voice contract; eight agents convert eight
disjoint sections in place; eight fresh auditors claim-diff against
`git show main:` and voice-check; the controller verifies and force-pushes.

**Tech stack:** Fumadocs MDX under `apps/docs/content/docs/`, bun test content
suite, `turbo build --filter=@internal/docs`.

## Global Constraints

- Page set frozen: no file created, deleted, renamed, or merged; no meta.json
  edits; content moves only within its own page.
- Zero factual drift; AGENTS.md binding (never invent, vocabulary, MDX rules);
  no U+2014; no new components; links only to pages that exist.
- Agents never run git mutations; the controller commits per wave.

### Task 1: Voice fleet (8 agents, parallel)
- [ ] Each agent rewrites every page in its section per STYLE.md: sentences,
  headings, frontmatter descriptions, numbered steps, Prerequisites/Notes
  shape. Reports per-page word counts and anything unverifiable.
- [ ] Controller commits: "docs: Tailscale/NetBird voice pass across all eight sections".

### Task 2: Audit fleet (8 fresh agents, parallel)
- [ ] Adversarial fidelity: checklist of every claim in each main original;
  verify survival in the rewrite; fix drift in place (the rewrite or the
  auditor's fix is the only place to fix).
- [ ] Voice: STYLE.md banned-pattern scan (slogans, fragments, anthropomorphic
  verbs, staccato runs, cheeky headings); fix.
- [ ] Controller commits audit fixes.

### Task 3: Verify + ship
- [ ] `cd apps/docs && bun test` green; `bunx turbo build --filter=@internal/docs`
  green; `bun run lint:check`; `bun run verify-types`; `bun run test`;
  `grep -rn $'—' apps/docs/content` empty.
- [ ] `@internal/docs` minor changeset; commit; `git push --force-with-lease`;
  rewrite PR #219 title/body to describe the voice pass.
