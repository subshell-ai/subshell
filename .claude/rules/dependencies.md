# Dependencies

## Pinned Package Versions

All package versions in `package.json` files must be pinned (exact versions without `^` or `~` prefixes).

**Do this:**
```json
{
  "dependencies": {
    "react": "19.0.0",
    "recharts": "3.7.0"
  }
}
```

**Not this:**
```json
{
  "dependencies": {
    "react": "^19.0.0",
    "recharts": "~3.7.0"
  }
}
```

After installing packages with `bun add`, run `syncpack fix` to remove version prefixes, then `bun install` to update the lockfile.

## The lockfile's workspace versions are the exception

`bun install` updates the lockfile for everything EXCEPT one field: the
`version` bun records for each workspace. It writes that once and never
resyncs it. Measured on bun 1.4.0 with a workspace bumped in its package.json
and the lockfile left behind, `bun install`, `--force`, `--lockfile-only` and
`--lockfile-only --force` all leave the stale value, and
`bun install --frozen-lockfile` exits **0** instead of objecting — so nothing
in CI sees it either.

Do not reach for `bun install` there, and do not delete the lockfile to force
it: a from-scratch resolve also moves `lockfileVersion` and floats hundreds of
transitive dependencies, which is a dependency upgrade rather than a repair.

```bash
bun run lint:lockfile      # does bun.lock agree with every package.json?
bun run lint:lockfile:fix  # rewrite just those version fields
```

This is the ONLY sanctioned edit to `bun.lock` that is not a `bun install`, and
`scripts/lockfile-workspace-versions.ts` is deliberately narrow enough to stay
that way — it resolves nothing, adds nothing and reorders nothing. Everything
else in that file still comes from bun.

The pre-commit hook will fail if unpinned versions are committed.
