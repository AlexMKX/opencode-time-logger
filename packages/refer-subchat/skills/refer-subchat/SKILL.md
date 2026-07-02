---
name: refer-subchat
description: Use when you need to recall what happened in ANOTHER opencode chat in this project — triggers include "в прошлом чате / in a previous chat", "посмотри другой чат / check the other session", "мы это уже обсуждали / we discussed this before", "summarize chat X", or needing a decision/detail from a session that is not the current one. Do NOT use it for the current chat's own history.
---

# Refer Subchat

Pull knowledge out of a *different* chat in the **current project** without
dragging its whole transcript into your context. Backed by the deterministic
`refer_subchat` tool, which summarizes the referenced chat in-process and
returns only the small result — so referencing a huge chat is cheap.

## When to reach for it

- The user references an earlier session ("как мы решили в прошлом чате…",
  "we already set that up in another session").
- You need a decision, value, or file from a chat that is **not** the one you
  are in.
- You want to search several past chats for where something was discussed.

Do **not** use it to re-read the current chat — you already have that context,
and for billing boundaries use `time_logger_extract_sessions` instead.

## Hard boundary: current project only

The tool derives the current project from the tool context and **rejects any
session id from another project**. You cannot point it at chats outside the
project you are working in. This is enforced by the tool, not by convention.

## Two-step usage

1. **Discover.** Call `refer_subchat` with **no arguments**. You get a listing
   of this project's chats: `id`, `title`, `updated_iso`. Pick the one you want.
2. **Reference.** Call `refer_subchat` again with `session_id` set to that id:
   - default → an in-process **summary** of that chat;
   - add `keywords: ["…"]` → the summary **plus** the ±3 lines around each
     keyword hit (case-insensitive substring match);
   - add `lines_only: true` (with keywords) → **only** those context windows,
     skipping summarization entirely (cheapest — no model call).

## Choosing the mode

- Need the gist of a chat → summary (no keywords).
- Looking for a specific fact/decision → summary **with** keywords (summary
  gives context, windows give the exact lines).
- You only need the exact surrounding lines and want it cheap/fast →
  `lines_only: true` with keywords.

## Notes

- Large chats are summarized with multi-pass map-reduce automatically; you just
  get the final summary and a `passes`/`chunks` count.
- Summarization uses a cheap pinned model, so it does not burn your main model.
- If you pass keywords that never appear, `windows_text` is
  `(no keyword matches)` — the summary is still returned.
