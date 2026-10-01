# Engineering documentation

Public user guides and developer tutorials live in
[`apps/docs/content/docs`](../apps/docs/content/docs) and are published at
[docs.subshell.sh](https://docs.subshell.sh). Keep procedures there; internal
notes should link to them and explain only the additional engineering details.

## Working on the codebase

- [Root agent instructions](../AGENTS.md): vocabulary, licensing, development commands, verification, and app-level documentation routing.
- [Security model](security.md): threats, enforced boundaries, accepted risks, and implementation evidence.
- [Security follow-ups](security-actionable.md): unresolved work, decision triggers, and regression history.
- [Release and CI](release-and-ci.md): build, signing, publishing, updates, and deployment mechanics.
- [Design system](design-system.md): product tokens and implementation constraints.
- [Documentation authoring](../apps/docs/AGENTS.md) and [style guide](../apps/docs/STYLE.md): public site structure, language, visuals, and verification.
- [Proxmox submission research](proxmox-community-submission.md): external acceptance criteria and future integration work.

Each app's `AGENTS.md` routes to its own implementation notes. Preserve details
such as failure handling, migration contracts, service-manager behavior, and
why a previous fix is necessary, even when a public guide explains the feature.

## Historical decisions

`superpowers/specs/` and `superpowers/plans/` preserve design decisions and
implementation records. Paths and proposed behavior in dated records can
refer to former files or designs. Use the current implementation and app
instructions for present behavior; do not maintain a second current user
guide in these archives.
