# opencode-time-logger

OpenCode plugin and skill that turns an opencode chat into Jira activity:
create an issue, append worklogs based on actual chat work-sessions, and
optionally drive the issue to a closed status — without hard-coding any
workflow status name.

## What you get

- **Plugin** that registers a tool `time_logger_extract_sessions`. The tool
  reads the current chat through the official OpenCode SDK, groups messages
  into billable work-sessions, and returns Jira-ready JSON (durations rounded
  up to 15 minutes, timestamps in the exact format Jira worklog tools require).
- **Skill** `jira-time-tracker` (auto-registered via the plugin). The skill
  picks the right MCP server per task:
  - text content (issue, comment, worklog) — prefers the official **Atlassian
    MCP** with ADF for full fidelity;
  - workflow transitions and Agile / sprint operations — uses
    [`mcp-jira`](https://github.com/sooperset/mcp-atlassian);
  - per-project knowledge (project key, default issue type, last known
    "closed" status, active ticket, etc.) — `supermemory`.
- **Tool** `refer_subchat` + **skill** `refer-subchat` — reference *another*
  chat in the **same project** without loading its transcript into your
  context. The tool summarizes the referenced chat in-process (in a throwaway
  session) and returns only the summary, so pulling from a huge chat is cheap.
  See [Refer subchat](#refer-subchat) below.

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

- At least one Jira MCP server reachable from OpenCode. The skill prefers the
  official Atlassian MCP for text content and falls back to `mcp-jira`
  (Sooperset) for workflow / sprint operations. Either alone works; both
  available gets you full fidelity.
- A `supermemory` MCP server for accumulated per-project knowledge
  (`project_key`, `issue_type`, `last_known_close_status`, `active_ticket`,
  default board id, etc).

## Usage

In any chat:

- `новый тикет: …` / `new ticket: …` — create an issue with worklogs for
  every work-session in the chat. The skill will offer to assign the issue
  to the active sprint (if exactly one is detected) and to fill Original /
  Remaining Estimate from the extractor totals.
- `PROJ-123 добавь / append / log: …` — add worklogs for work done since this
  session's last extraction. The tool keeps a per-session cursor (read back from
  its own prior outputs in the chat), so appending from the same session never
  re-logs already-billed time — and parallel sessions on the same ticket don't
  interfere with each other's cursors.
- `закрой тикет PROJ-123` / `двигай тикет PROJ-123 в <status>` — walk the
  workflow one transition at a time, discovering the project's closed
  status dynamically when needed.

The skill never acts on a bare invocation: with no clear trigger it asks
what you want. If a ticket is mentioned in the recent chat context it offers
to log into it rather than silently creating a new one. Before any
destructive write (create / worklog / transition) it shows a dry-run
preview and waits for confirmation.

Full workflow lives in `skills/jira-time-tracker/SKILL.md`.

## Refer subchat

`refer_subchat` lets an agent recall what happened in a *different* chat of the
current project without dragging that (possibly huge) transcript into its own
context.

- **Discover** — call with no arguments to get a listing of the project's chats
  (`id`, `title`, `updated_iso`).
- **Reference** — call again with a `session_id` from that listing:
  - default → an in-process **summary** of that chat;
  - `keywords: […]` → the summary **plus** the ±3 lines around each
    case-insensitive substring hit;
  - `lines_only: true` (with keywords) → **only** those context windows, no
    model call.

Guarantees:

- **Project isolation is enforced by the tool.** The current project is derived
  from the tool context (never an argument); any `session_id` from another
  project is rejected. Matching is by `projectID`, so git worktrees of one
  project still count as the same project.
- **The transcript never reaches the calling agent.** Summarization runs in a
  throwaway session (tools disabled, hard summarizer prompt), which is always
  deleted afterwards and hidden from the discovery listing.
- **Large chats** are summarized with automatic multi-pass map-reduce, using a
  cheap pinned model (config `small_model`, else the cheapest suitable model,
  else the OpenCode default). When picking automatically it prefers a cheap
  model from the **same provider as your main model**, so a referenced chat's
  content does not silently cross to a different vendor.

Full guidance lives in `skills/refer-subchat/SKILL.md`.

## How work-sessions are computed

- A work-session is a contiguous stretch of chat messages where the gap
  between any two consecutive messages stays under 15 minutes.
- A gap longer than 15 minutes ends the current work-session — this correctly
  handles an overnight pause even when both adjacent messages are assistant
  messages (a resume-after-sleep would otherwise look like one giant session).
- Each work-session is clamped to a minimum of 15 minutes and its billable
  duration is rounded up to the next 15-minute increment.

Both thresholds are hard-coded constants (`GAP_MINUTES = MIN_MINUTES = 15`).
The tool exposes no arguments to override them — every prior bug in this
plugin came from option plumbing, not from the values themselves.

## Development

```sh
bun install
bun test
```

Tests run on every PR to `main` via GitHub Actions.

## License

MIT
