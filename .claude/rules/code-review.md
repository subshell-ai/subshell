# Code Review

All pull requests should receive a code review before merging. Use the `code-reviewer` agent to automatically review PRs for:

- Bugs and logic errors
- Code comment violations
- Historical context from git blame
- Patterns from previous PR feedback

When implementing fixes based on code review feedback:
- Always add tests for bug fixes when possible
- Update relevant documentation if the fix affects behavior

## Review until clean

Once a change is ready for review, run the `code-reviewer` agent, address every
finding, then review again. Repeat the loop until a full pass comes back with no
MAJOR and no MINOR issues. A single round that still has open minor findings is
not done: fix them (adding a test where one is a bug) and re-review. Nits are
judgment calls; majors and minors are not. Do not merge while any major or minor
finding remains open.
