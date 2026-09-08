# Code Review

All pull requests should receive a code review before merging. Use the `code-reviewer` agent to automatically review PRs for:

- Bugs and logic errors
- Code comment violations
- Historical context from git blame
- Patterns from previous PR feedback

When implementing fixes based on code review feedback:
- Always add tests for bug fixes when possible
- Update relevant documentation if the fix affects behavior
