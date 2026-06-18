---
name: jira-time-tracker
description: Use when the user wants to create a Jira ticket, append worklogs to an existing Jira ticket, or move a Jira ticket through its workflow based on the current opencode chat — triggers include "новый тикет / new ticket", an explicit "PROJ-123" key together with a verb like "add / append / log / добавь", and "закрой тикет / close ticket / двигай тикет".
---

# Jira Time Tracker

Convert the current opencode chat into Jira activity: a new issue, fresh worklogs on an existing one, and optionally a workflow walk. Work-session boundaries come from the deterministic `time_logger_extract_sessions` tool — never eyeball timestamps.

## Hard rule: explicit trigger required

If the user message does not contain a clear instruction to create a ticket, append worklogs, or move a ticket, **ask** what they want. Do not act on a bare skill invocation (just the SKILL.md text loaded into the chat). Acceptable triggers:

- create — phrases like `новый тикет`, `new ticket`, `создай тикет`
- append — an explicit issue key (`[A-Z][A-Z0-9_]+-\d+`) together with a verb (add / append / log / добавь)
- move — `закрой тикет`, `close ticket`, `двигай тикет`, `transition to <status>`

When in doubt, ask. A bare `/skill jira-time-tracker` is not a trigger.

## Reuse an existing ticket before creating a new one

Before going into create mode, look for a ticket the user is already working on:

1. Scan the current chat (and any context preserved through compaction) for explicit `[A-Z][A-Z0-9_]+-\d+` keys, links to `…/browse/<KEY>` URLs, or branch names that embed a key.
2. Check `supermemory` for a recent `active_ticket` entry for this project / cwd.
3. If you find candidates, ask the user: "I see PROJ-123 in context — log to it (append), or create a new ticket?" Do not silently choose.

Only fall through to creating a fresh issue when no candidate exists and the user explicitly asks for a new one.

## Tool choice (use the right MCP server for the job)

Two Jira MCP servers may be available. Pick per task:

- **Text content** (create issue, edit issue, add/edit comment, add/edit worklog) — prefer the **official Atlassian MCP** (`atlassian mcp` server: `createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`, `addWorklogToJiraIssue`, `getJiraIssue`, `searchJiraIssuesUsingJql`). Send content as **ADF** (`contentFormat: "adf"`). ADF gives full fidelity and avoids the Markdown↔wiki conversion guesswork. If the official MCP is not available, fall back to whatever Jira MCP is present (e.g. `mcp-jira`/`sooperset`) and follow its native format (Markdown for sooperset).
- **Workflow operations** (list transitions, transition issue) — use `mcp-jira` (`jira_get_transitions`, `jira_transition_issue`). The official MCP can only apply transitions at create time, not on demand.
- **Agile / sprint operations** (find boards, list sprints, add issue to sprint) — use `mcp-jira` (`jira_get_agile_boards`, `jira_get_sprints_from_board`, `jira_add_issues_to_sprint`).
- **Search by JQL** — either works; the official MCP is slightly richer.

All Jira write tools are marked destructive by the server. Invoke them through `call_tool_destructive` (or the destructive variant your runtime exposes) on the first attempt — do not waste a turn trying a non-destructive caller first.

## Step 1 — Load accumulated knowledge

`supermemory` `search` with `query: "jira-time-tracker config"`, `scope: "project"`. Read whatever is there (project_key, default issue_type, jira_base_url, cloudId, default board id, last_known_close_status, active_ticket). When something needed for the current mode is missing, ask once and persist it with `add`, `type: "project-config"`, `scope: "project"`.

## Step 2 — Resolve the chat session

The plugin tool defaults `session_id` to the current chat. Pass an explicit id only when the user references a different chat by `ses_…` id or URL.

## Step 3 — Extract work-sessions

For **create** mode:

```
time_logger_extract_sessions {}
```

For **append** mode, find the cutoff first:

1. `jira_get_worklog(issue_key)` (or `getJiraIssue` with `fields: ["worklog"]`).
2. Compute `last_logged_until_ms` = `max(started_epoch_ms + timeSpentSeconds * 1000)` over the existing worklogs. With no worklogs, omit `since_ms`.
3. `time_logger_extract_sessions { since_ms: <ms> }`.

The tool result is authoritative. Do not re-derive durations from the chat.

## Step 4 — Dry-run preview before any write

After you know what you're about to do, present a short preview to the user **once**:

- Mode (create / append / move).
- Target issue (existing key or "new issue in project XXX, type YYY").
- Proposed summary + first 6–10 lines of description (create mode only).
- Worklog plan: a compact table — index, started, billed time, one-line comment.
- Sprint assignment (if create mode and an active sprint is detected).

Wait for `да / ok / go` before any destructive call. The preview prevents the duplicate-create / duplicate-worklog spirals seen in earlier runs.

## Step 5 — Create the issue (create mode)

Compose a focused summary (≤120 chars) and a description that reflects what was actually done in this chat. Use the formatting native to the MCP you chose (ADF via the official MCP, otherwise Markdown). Pull MR / PR / issue links from the chat context as full URLs; do not write bare `#NN` references — describe the change in words if no URL is available.

**Do not** include a "Sessions" / "Worklogs" / "Time log" block in the description. The worklogs are the source of truth for time spent.

Call the create tool **once** through its destructive caller. Capture the returned `key`.

### Estimates and sprint (post-create, before worklogs)

Immediately after the issue is created:

1. **Estimates.** If the project's issue type carries `timetracking` (Original Estimate / Remaining Estimate), set them from the extractor totals. Set Original Estimate to the total billed time across all work-sessions; set Remaining Estimate to `0m` if you are about to log everything (the work is done), otherwise to the unlogged portion. Use the official MCP's `editJiraIssue` with `fields: { "timetracking": { "originalEstimate": "Xh Ym", "remainingEstimate": "Zm" } }`. If the field is not on the screen / not configured, the edit returns an error — log it and continue.
2. **Active sprint.** Look up the project's scrum board: `jira_get_agile_boards { project_key, board_type: "scrum", limit: 5 }`. If there is exactly one active scrum board, fetch its active sprint: `jira_get_sprints_from_board { board_id, state: "active", limit: 5 }`. If there is exactly one active sprint, **propose** to the user to add the issue to it. On confirmation: `jira_add_issues_to_sprint { sprint_id, issue_keys: <key> }`. Multiple boards or multiple active sprints — ask the user which one. No board / no active sprint — skip silently.

## Step 6 — Add worklogs

For each work-session in chronological order, call the worklog tool once. Use the value from `work_session.start_jira` as the `started` argument (it is already in `yyyy-MM-dd'T'HH:mm:ss.SSSZ`, the format both Jira MCPs require). Comment per work-session should be one specific line of what happened in that slice — you have the conversation in context, write something useful.

Apply the same formatting rule as Step 5 (ADF for official MCP, Markdown otherwise). Do not edit a worklog or comment more than once. If the first version looks wrong on read-back, fix it once and stop — repeated edits produce no value and pollute the history.

## Step 7 — Walk the workflow (move mode)

Goal: drive the issue along its workflow as the user requested, **without hard-coding any status name**.

1. Determine the target status:
   - If the user named one in their message, use that.
   - Else if the user said "close ticket" / "закрой тикет" and supermemory has `last_known_close_status` for this project, target it.
   - Else discover the project's closed status: `searchJiraIssuesUsingJql` (or `jira_search`) with `jql: "project = <KEY> AND statusCategory = Done ORDER BY resolved DESC"`, `fields: ["status"]`, `limit: 1`. Take `status.name`. Persist it to supermemory as `last_known_close_status`. Empty result — ask the user.
2. Walk transitions, up to 5 hops:
   - `jira_get_issue` (`fields: "status"`) — current status.
   - If it matches the target, stop.
   - `jira_get_transitions` — pick the transition whose `to.name` equals the target. If none matches directly, pick a transition whose `to.name` is different from the current name and is not obviously backwards (avoid names containing "reopen", "cancel", "reject", "back", "return", "вернуть").
   - `jira_transition_issue` with that transition id.
   - Loop.
3. If 5 hops are not enough, stop and report the path taken plus the status you ended at. Do not silently succeed.

This whole step is "drive the ticket along its workflow", not "close it by any means". One transition step at a time, never skip statuses.

## Step 8 — Report to the user

Print:

- Mode(s) actually executed.
- Issue key and URL (`{jira_base_url}/browse/{key}` if known).
- Worklog count, total billed minutes, total raw minutes.
- Sprint assignment, if performed.
- For move mode: the chain of transitions taken and the final status.

## Quick reference

| Mode    | Triggers                                                    | Steps run                              |
|---------|-------------------------------------------------------------|----------------------------------------|
| create  | `новый тикет`, `new ticket`, `создай тикет`                 | 1, 2, 3, 4, 5, 6, 8                    |
| append  | `PROJ-123` + verb                                           | 1, 2, 3 (with `since_ms`), 4, 6, 8     |
| move    | `закрой тикет`, `close ticket`, `двигай тикет`, `transition`| adds 7 after create/append             |

## Algorithm defaults (informational)

- Gap between any two consecutive messages > 10 min ⇒ work-session split.
- Minimum work-session = 15 min.
- Worklog duration rounded up to nearest 15 min.

Override `gap_minutes` / `min_minutes` only when the user explicitly asks.

## What NOT to do

- Don't act on a bare skill invocation. No explicit trigger ⇒ ask.
- Don't create a new issue when there's a plausible existing one in context — propose it first.
- Don't include a sessions / worklog / time-log block in the issue description.
- Don't write bare `#NN` references. Full URL from chat context, or words.
- Don't try `call_tool_write` for jira create / worklog / transition tools first — they are destructive; go straight to the destructive caller.
- Don't edit a comment or worklog more than once.
- Don't re-log work-sessions already in Jira worklogs (use `since_ms` in append mode).
- Don't hard-code workflow status names. Discover them from the project.
- Don't skip statuses — walk the workflow one transition at a time.
- Don't leak PII or internal infrastructure identifiers (hostnames, IPs, internal domains, usernames). Replace with example placeholders before sending to Jira.
