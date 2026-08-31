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

The pre-commit hook will fail if unpinned versions are committed.
