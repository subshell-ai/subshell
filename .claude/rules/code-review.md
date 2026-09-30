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
MAJOR and MINOR finding (NITs are at your discretion), then review again. Repeat
the loop until a full pass returns zero MAJOR and zero MINOR findings. A round
that still has an open MAJOR or MINOR finding is not done: fix it and re-review,
adding a test for a bug fix when possible (per above). Do not merge while any
MAJOR or MINOR finding remains open.
