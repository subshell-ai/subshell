# Claude subagent progress integration

Investigated on 2026-10-20 against installed Claude Code 2.1.296. This is an
integration constraint, not an implemented live-summary bridge. User-facing
behavior is documented in the [subagents guide](../apps/docs/content/docs/agents/subagents.mdx).

## Three different labels

- The Agent tool's `description` and the subagent `.meta.json` description
  describe the delegated task, such as “Report system info”.
- A child tool's `tool_input.description` describes a tool invocation, such
  as “Sleep for 6 minutes”. We tried forwarding this label by exact `agent_id`, but removed that
  reporting because it cannot represent live progress.
- Claude's task picker can show a generated progress summary, such as
  “Retrying foreground sleep”. Updating tool descriptions doesn't reproduce
  this summary. Restarting the parent doesn't change that.

## Interfaces checked

The [command hooks reference](https://code.claude.com/docs/en/hooks) exposes
lifecycle and tool events, but no generated task-progress event.

The [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
documents `agentProgressSummaries` and `task_progress.summary`. The installed
CLI describes `--sdk-url` as requiring `-p` and `stream-json`; its
`--output-format` also requires print mode. These aren't an established
attachment interface for the existing interactive terminal.

The [mods API reference](https://code.claude.com/docs/en/plugins/mods/reference)
offers `$.agent.list()`. Its public `AgentInfo` declarations expose identity,
description, type, status, parent, and name, but no progress summary. Inspecting
2.1.296 confirms the adapter copies the task's `description`, not its generated
summary. Installing a mod that polls this method wouldn't fix the mismatch.
Recheck the installed version as these interfaces evolve.

## Decision and requirements for a future bridge

Keep the native interactive terminal and bounded spawn metadata
reports, but hide Claude descriptions in the sidebar. The operator chose names
and status only because mismatched descriptions look like stale live activity. Don't scrape rendered task rows, inspect private process memory, or
replace the harness with print mode to make the labels match.

A future bridge needs a supported interactive event or metadata API carrying
the generated summary and exact subagent ID. Before enabling it:

1. Verify a real interactive parent keeps its terminal controls while summaries
   update, including changes during a single long-running tool call.
2. Store task description and live activity separately. A late description
   report must not overwrite a newer summary.
3. Scope updates to the parent generation and child run so resumed agents
   reject late updates from their previous run. Clear activity when its run
   ends and fall back to the task description when no current activity exists.
4. Test parallel children, renames, resumption, reconnects, out-of-order events,
   and older harness versions on both server-host and enrolled-node launches.
5. Forward only bounded labels, IDs, and lifecycle metadata through the
   existing authenticated reporting path, never prompts or transcripts.

Until that interface is verified, don't advertise exact task-picker progress
or tell a user another restart will enable it.
