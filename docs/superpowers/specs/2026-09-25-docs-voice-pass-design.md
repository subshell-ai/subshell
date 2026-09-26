# Docs voice pass (Tailscale/NetBird style)

Date: 2026-09-25. Status: approved direction, executing on
`docs/digestibility-rewrite`.

## History

A first attempt restructured the site (merges, new tutorial spine, hoisting
detail into Reference). The operator reviewed it and rejected it wholesale:
"this is just awful." The direction chosen instead: keep main's page set,
URLs, and organization untouched, and apply only a documentation voice modeled
on the Tailscale and NetBird docs. This spec replaces
`2026-09-25-docs-digestibility-design.md` (deleted).

## The voice

Neutral, professional, task-shaped, consistently slightly boring. Concretely
(vs the two voices being replaced):

- Not main's current voice: 40-60-word sentences, exceptions welded to rules,
  density everywhere.
- Not the rejected rewrite's voice: punchy-quirky, slogan headings, dramatic
  fragments, anthropomorphic verbs, staccato rhythm.
- Target (calibrated against Tailscale's quickstart/concepts pages and
  NetBird's self-hosted guide): plain task headings; neutral one-line page
  descriptions; numbered steps with calm result sentences ("Once you are
  authenticated, the device will appear..."); "we recommend" for advice;
  warnings stated as fact plus consequence, never as suspense.

`apps/docs/STYLE.md` is the full contract with calibration pairs and is the
agents' gate.

## Hard scope limits

- No page created, deleted, moved, or merged. No meta.json edits. No URL
  changes. Content may move only within a single page (a caveat later on the
  same page, never onto another page).
- Zero factual drift: every claim, default, flag, qualifier, version, and
  security warning survives. `apps/docs/AGENTS.md` (never invent, vocabulary,
  MDX rules, the em-dash ban) stays binding.

## Pipeline

Eight track agents over the same disjoint section split as before
(Home+get-started, use, nodes, server+plugins, agents+automation, develop,
reference, about+help), rewriting prose in place; then eight fresh auditors:
adversarial claim-diff vs main plus a STYLE.md voice check, fixing in place;
then controller verification (content suite, MDX build, lint, types, full test
suite), a `@internal/docs` changeset, and a force-push to the existing PR.
