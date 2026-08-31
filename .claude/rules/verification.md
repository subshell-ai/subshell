# Verification

**Always run verification after making code changes.** Don't wait to be asked or until you "feel confident" - run these immediately after any modification:

```bash
bun run verify-types
bun run lint:check
bun run test
```

If any of these fail, fix the issues before considering the task complete. Do not proceed to commits or other work until all three pass.

These are the same three commands the `pre-push` hook runs, so a clean local run means a clean push.

## `lint` vs `lint:check`

- `bun run lint` runs biome with `--write --unsafe`: it **fixes** what it can and rarely reports a failure. Use it while working.
- `bun run lint:check` runs biome read-only. Use it to verify, because it actually fails on anything unfixed and never leaves modified files behind.

The usual loop is `bun run lint` to fix, then `bun run lint:check` to confirm.
