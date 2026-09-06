# Changesets

Run `bunx changeset` after user-visible changes to any releasable app —
`@internal/server`, `@internal/client`, `@internal/desktop-server` or
`@internal/desktop-client`. The version PR on merge to main records the bump;
the release cut happens via `.github/workflows/release.yml`.

The `ignore` list in `config.json` is OPT-OUT: a new workspace package is
versioned the moment it exists. So a new *releasable* app needs no edit there
(just make sure it is absent), while every new shared package must be ADDED or
it starts appearing in the version PR and getting a CHANGELOG the publish job
would try to slice.
