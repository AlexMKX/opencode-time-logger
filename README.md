# opencode-time-logger

OpenCode plugin and skill that turns an opencode chat into Jira activity:
create an issue, append worklogs based on actual chat work-sessions, and
optionally drive the issue to a closed status — without hard-coding any
workflow status name.

## What you get

- **Plugin** that registers a tool `time_logger_extract_sessions`. The tool
  reads the current chat through the official OpenCode SDK, groups messages
  into billable work-sessions, and returns Jira-ready JSON (durations rounded
  up to 15 minutes, timestamps in the exact format `jira_add_worklog` requires).
- **Skill** `jira-time-tracker` (auto-registered via the plugin) that
  orchestrates the Jira side using the
  [`mcp-jira-sooperset`](https://github.com/sooperset/mcp-atlassian) MCP server
  and a `supermemory` MCP for per-project knowledge.

## Install

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-time-logger@git+https://github.com/AlexMKX/opencode-time-logger.git"
  ]
}
```

OpenCode pulls the package on the next start. The skill becomes visible as
`jira-time-tracker` and the tool as `time_logger_extract_sessions`.

### Prerequisites

- A reachable Jira instance via the `mcp-jira-sooperset` MCP server.
- A `supermemory` MCP server for storing per-project config
  (`project_key`, `issue_type`, `last_known_close_status`, etc).

## Usage

In any chat:

- `новый тикет: …` / `new ticket: …` — create an issue with worklogs for
  every work-session in the chat.
- `PROJ-123 добавь / append / log: …` — add worklogs for sessions newer than
  the last logged time on the ticket.
- `закрой тикет PROJ-123` / `close ticket PROJ-123` — discover the project's
  closed status dynamically and walk the workflow to it.

The skill defines the full workflow; see `skills/jira-time-tracker/SKILL.md`.

## How work-sessions are computed

- A work-session is a contiguous stretch of chat messages where the gap
  between any two consecutive messages stays under 10 minutes.
- A gap longer than 10 minutes ends the current work-session — this correctly
  handles an overnight pause even when both adjacent messages are assistant
  messages (a resume-after-sleep would otherwise look like one giant session).
- Each work-session is clamped to a minimum of 15 minutes and its billable
  duration is rounded up to the next 15-minute increment.

## Development

```sh
bun install
bun test
```

Tests run on every PR to `main` via GitHub Actions.

## License

MIT
