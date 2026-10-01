# Documentation follow-ups

- [x] Finish the Developers revision: complete plugin examples, API reference, packaging and installation instructions, contributor setup, and relevant diagrams. Verify examples against the current implementation.
- [x] Add a dedicated **Reusable Prompts** section after the Developers revision. Cover creating and editing prompts, using them at launch and in active subshells, sharing and ownership, and MCP access. Verify UI labels, permissions, and behavior against the implementation; update links from the existing saved-prompts guide.
- [x] Give Presets its own section with a coding-agent configuration, launch-default guidance, and useful screenshots. Remove the trivial launch and Bash-preset screenshots.
- [x] Document dashboard server and node updates, including fleet updates, compatibility holds, desktop alternatives, and completion checks.
- [x] Add compact, zoomable screenshots of the prompt library and an expanded ordered stack.
- [x] Update the documentation style guide with the developer tutorial requirements and any new reusable-prompts terminology.
- [x] Run documentation tests, type checks, and static-export verification for the completed changes.

Verification: 165 documentation tests passed; lint, type checks, production build,
and export verification passed for 117 pages. Extracted plugin examples passed
type checks and all eight tests, built and packed successfully, and passed
registry installation and compiled-loader checks. Wide and narrow browser checks
found no page overflow; screenshots remained at or below 320px display height.
The prompt-stack image zoom opened in the same tab and closed with Escape.
