# Changesets

Run `bunx changeset` after user-visible changes to any releasable app —
`@internal/server`, `@internal/node`, `@internal/desktop-server` or
`@internal/desktop-client`. The version PR on merge to main records the bump;
the release cut happens via `.github/workflows/release.yml`.

The Action commits `changeset version`'s bumps itself, so lefthook's local
"update bun lockfile" hook never runs — which is why `version-packages` ends
with `lint:lockfile:fix`. Bun does not resync a workspace's recorded version on
install, and `--frozen-lockfile` does not object to a stale one, so without
that step `bun.lock` trails a release. It did, for one.

The `ignore` list in `config.json` is OPT-OUT: a new workspace package is
versioned the moment it exists. So a new *releasable* app needs no edit there
(just make sure it is absent), while every new shared package must be ADDED or
it starts appearing in the version PR and getting a CHANGELOG the publish job
would try to slice.
