---
name: jira-time-tracker
description: Use when the user wants to create a Jira ticket, append worklogs to an existing Jira ticket, or close a Jira ticket based on the current opencode chat — triggers include "новый тикет / new ticket", an explicit "PROJ-123" key together with a verb like "add / append / log / добавь", and "закрой тикет / close ticket".
---

# Jira Time Tracker

You convert the current opencode chat into Jira activity: a new issue, fresh worklogs on an existing issue, and/or a workflow transition to a closed status. Work-session boundaries come from a deterministic plugin tool — never eyeball timestamps.

## Triggers and modes

- `новый тикет` / `new ticket` → mode = **create**
- explicit `PROJ-123` (any `[A-Z][A-Z0-9_]+-\d+`) plus a verb (add / append / log / добавь) → mode = **append**
- `закрой тикет` / `close ticket` → also run **close** after create/append

Modes combine in one user message ("новый тикет и сразу закрой").

## Tools

- `time_logger_extract_sessions` (from this plugin) — computes work-sessions from the current chat.
- MCP server `mcp-jira-sooperset`:
  - read: `jira_get_issue`, `jira_get_worklog`, `jira_get_transitions`, `jira_search`
  - write: `jira_create_issue`, `jira_add_worklog`, `jira_transition_issue`
- `supermemory` MCP — accumulated per-project knowledge.

## Step 1 — Load accumulated knowledge

`supermemory` `search` with `query: "jira-time-tracker config"`, `scope: "project"`. Use whatever is there:

- `project_key`, `issue_type`
- `jira_base_url` (for printing issue URLs to the user)
- `last_known_close_status` (the status name observed on previously closed tickets in this project)

If a value needed by the current mode is missing, ask the user once and persist it back with `add`, `type: "project-config"`, `scope: "project"`.

## Step 2 — Resolve the chat session

The plugin tool defaults `session_id` to the current chat session — you almost never need to pass it. Pass an explicit id only when the user references a different chat by `ses_…` id or by its URL.

## Step 3 — Extract work-sessions

**create** mode:

```
time_logger_extract_sessions {}
```

**append** mode:

1. `jira_get_worklog(issue_key=…)`.
2. Compute `last_logged_until_ms` = `max(started_epoch_ms + timeSpentSeconds * 1000)` across the returned worklogs. If there are no worklogs, omit `since_ms`.
3. `time_logger_extract_sessions { since_ms: <ms> }`.

The tool result is authoritative. Do not re-derive durations from the chat history yourself.

## Step 4 — Compose Jira text (rules)

Jira (Cloud or Server, served through the MCP) interprets text as Jira wiki markup, not Markdown. Follow these rules for every description, comment, and worklog body:

- **Plaintext.** No `**bold**`, no `*emphasis*`, no `_underline_`, no `+plus+`, no Markdown headings (`#`, `##`).
- **Identifiers** (filenames, paths, code symbols, table names) — wrap in `{{…}}` for Jira monospace.
- **Hyperlinks** — emit the bare URL on its own; Jira auto-links it. Never write a number alone like `MR #12` — that is unhelpful and degrades the worklog. Either include the full URL extracted from the chat context, or omit the reference and describe the change in words.
- **Sanitize.** Do not leak internal infrastructure identifiers (hostnames, internal domains, IPs, customer names, usernames, tokens). Replace with example-style placeholders (`example.com`, `host1.example.com`, `TEST-NET-1` IPs) before sending to Jira.
- **No emojis.** Anywhere.

If you cannot find a full URL for a referenced MR/PR/issue in the chat context, do not invent one and do not write a bare `#NN`. Describe the change instead.

## Step 5 — Create the issue (create mode)

Compose a focused summary (≤120 chars) describing what was actually done in this chat. Compose a Markdown-free Jira-wiki description with 2–6 short bullet points. **Do not** include a "Sessions" / "Worklogs" / "Time log" section in the description — the worklogs are the source of truth for time spent.

Call `jira_create_issue` with `project_key`, `summary`, `issue_type`, `description`. Capture the returned `key`.

## Step 6 — Add worklogs

For each work-session in chronological order:

```
jira_add_worklog(
  issue_key  = <key>,
  time_spent = <work_session.jira_time_spent>,   # "15m", "1h 30m", …
  started    = <work_session.start_jira>,         # use start_jira, NOT start_iso
  comment    = <one-line description of what happened in this slice>,
)
```

- The `started` field MUST come from `work_session.start_jira` (Jira-required `yyyy-MM-dd'T'HH:mm:ss.SSSZ` shape). Passing `start_iso` will fail with "Invalid date format".
- The per-session comment must reflect what actually happened in that slice — you have the conversation in context, write something specific (not "worked on stuff").
- Apply Step 4 rules to every comment.

## Step 7 — Close the ticket (close mode)

Goal: drive the issue to a status that the project considers closed, without hard-coding any status name.

1. If the user named a target status in their message, use that.
2. Else if supermemory has `last_known_close_status` for this project, target it.
3. Else discover it from the project itself:
   ```
   jira_search { jql: "project = <KEY> AND statusCategory = Done ORDER BY resolved DESC", limit: 1, fields: "status" }
   ```
   Take `status.name` from the result and persist it to supermemory as `last_known_close_status`. If the search returns nothing, ask the user for the target status name once and persist it.
4. Walk the workflow up to 5 hops:
   - `jira_get_issue(issue_key=…, fields="status")` → current status.
   - If current matches the target, stop.
   - `jira_get_transitions(issue_key=…)` → pick the transition whose `to.name` equals the target. If none directly matches, pick a transition whose `to.name` differs from the current name and does not look like a backwards move (avoid names containing "reopen", "cancel", "reject", "back").
   - `jira_transition_issue(issue_key=…, transition_id=…)`.
   - Repeat.

If you exhaust 5 hops without reaching the target, report which status you stopped at and why; do not silently succeed.

## Step 8 — Report to the user

Print:

- Mode(s) used.
- Issue key and URL (`{jira_base_url}/browse/{key}` if known).
- Worklog count, total billed minutes, total raw minutes.
- For close mode: final status and the transition path taken.

## Quick reference

| Mode    | Triggers                                  | Steps run                          |
|---------|-------------------------------------------|------------------------------------|
| create  | `новый тикет`, `new ticket`               | 1, 2, 3, 4, 5, 6, 8                |
| append  | `PROJ-123` + verb                         | 1, 2, 3 (with `since_ms`), 4, 6, 8 |
| close   | `закрой тикет`, `close ticket`            | adds 7 after create/append         |

## Algorithm defaults (informational)

- Gap between any two consecutive messages > 10 min ⇒ work-session split.
- Minimum work-session = 15 min.
- Worklog duration rounded up to nearest 15 min.

Override `gap_minutes` / `min_minutes` only when the user explicitly asks for non-default values.

## What NOT to do

- Don't include a sessions/worklog/time-log block inside the issue description — Jira already shows worklogs.
- Don't write bare `#NN` MR references. Either full URL from chat context, or describe the change without a link.
- Don't use Markdown emphasis (`**…**`, `*…*`, `_…_`). Don't escape characters by hand — let Jira wiki parse plaintext.
- Don't re-log work-sessions that already exist as Jira worklogs (use `since_ms` in append mode).
- Don't create the issue before extracting sessions — you need the chat context for both description and comments.
- Don't hard-code status names in the close step. Always discover them from the project.
- Don't leak PII or infrastructure identifiers to Jira.
