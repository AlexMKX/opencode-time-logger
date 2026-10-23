# refer-subchat — design

Date: 2026-07-02

## Goal

Give an agent a way to pull knowledge out of *another* chat in the **same
project** without loading that chat's (potentially huge) transcript into its own
context. Two things it can retrieve:

1. A **summary** of the referenced chat.
2. **Keyword windows** — ±3 lines around each keyword hit — when keywords are
   supplied.

The transcript never reaches the calling agent: the tool summarizes it
in-process (inside the plugin's Node runtime) via a throwaway session, and
returns only the small result string.

## Hard constraint: project isolation (security)

- The **current project** is derived from `ctx.sessionID`:
  `resolveRootSessionId` → `session.get` → `projectID`. Never accept a
  project/directory argument from the agent.
- A requested `session_id` is authoritatively checked: `session.get` on it, and
  its `projectID` must equal the current one. Mismatch → reject. `projectID`,
  not `directory` (git worktrees give different directories inside one project).
- The discovery listing filters `session.list` by the same `projectID`.

## Tool: `refer_subchat` (two modes)

Confirmed decisions:
- **Two-mode signature.** No `session_id` → return a compact list of the
  project's chats (`id`, `title`, `updated`, message count). With `session_id`
  → summary (+ keyword windows).
- **Output when keywords given:** summary **plus** ±3-line windows. A
  `lines_only` flag skips the model entirely (cheap grep-only path).
- **Summarization model:** a cheap pinned model, resolved at runtime with
  fallback (see below). Chats can be huge; opus-by-default is too expensive.

### Args (zod)

```
session_id?  string   // omit → discovery listing
keywords?    string[] // substrings, case-insensitive
lines_only?  boolean  // keywords required; skip summary, return only windows
```

No project/directory/model args — all inferred/pinned.

### Discovery mode (no session_id)

`session.list({ directory })` → keep only entries whose `projectID` matches the
current project, drop our own temp sessions (title prefix `[refer-subchat-tmp]`),
sort by `time.updated` desc, return `[{ id, title, updated_iso, message_count }]`.
`message_count` comes cheaply from list metadata if present, else omitted (we do
not fetch every session's messages just to count).

### Reference mode (session_id given)

1. Resolve current `projectID`; `session.get(session_id)`; reject on project
   mismatch or not-found.
2. `session.messages(session_id)` → flatten to lines (pure fn).
3. If `lines_only` **or** the cheap path is wanted: build keyword windows from
   the flattened lines, return them — **no temp session, no model cost**.
4. Otherwise summarize (map-reduce if large), and if keywords present, append
   the ±3-line windows to the summary result.

## Transcript flattening

`session.messages` returns `{ info, parts }[]`; parts include tool outputs that
can be enormous (file dumps).

- **For summary:** include user/assistant text parts; include tool outputs but
  **truncated** per part (cap, e.g. 800 chars) so a file dump can't blow the
  budget.
- **For keyword windows:** include tool outputs too (the user may be grepping
  for something a tool printed), but cap each *line* length so a minified blob
  stays one bounded line.

A "line" = one physical line after splitting every included text part on `\n`.
The flattened array carries `{ lineNo, role, msgId, text }` so windows can be
annotated with who said it.

## Keyword windows

Pure fn `keywordWindows(lines, keywords, radius = 3)`:
- case-insensitive substring match (regex is YAGNI for v1),
- for each hit collect `[i-radius, i+radius]`,
- merge overlapping/adjacent ranges,
- emit each merged range as a block with a header
  (`— lines 40–47, assistant @msg_x —`) and the line texts.

## Multi-pass summarization (large chats)

Char-threshold based (no exact token counting for v1):
- Build the summary transcript text; if under `MAX_CHARS` (e.g. ~48k), one pass.
- Else chunk on message/line boundaries into `MAX_CHARS` pieces, summarize each
  chunk (map), then summarize the concatenated chunk-summaries (reduce). One
  reduce level is enough for realistic chats; if the concatenation still exceeds
  the threshold, recurse the reduce.

Each summarization call:
- `session.create({ title: "[refer-subchat-tmp]" , directory })`
- `session.prompt({ tools: {}, system: <summarizer instruction>, model: <cheap>, parts:[text] })`
- read assistant text, `session.delete` in `finally`.

Smoke-tested: no explicit model still works (default), and `tools:{}` + a
`system` instruction suppress the agentic loop (clean text reply, zero tool
parts). We still pin a cheap model to control cost.

## Cheap-model resolution (runtime, with fallback)

1. `config.get()` → if `small_model` set, use it (`provider/model`).
2. Else `provider.list()`; prefer an active text-output model whose id matches
   /haiku|mini|flash|small/; else the cheapest by `cost.input + cost.output`.
3. Else omit `model` (opencode default).

## Module split (repo convention: pure fns in src/ with unit tests)

Pure (src/ + tests):
- `flatten-transcript.js` — messages items → `{lines, text}` (+ truncation caps).
- `keyword-windows.js` — lines + keywords → merged annotated windows.
- `chunk-text.js` — text + maxChars → boundary-aligned chunks.
- `resolve-summary-model.js` — (config, providers) → chosen model or null.

Orchestration (plugin): `refer-subchat.js` tool wiring the SDK calls, project
check, temp-session lifecycle. Kept thin.

## Skill

`skills/refer-subchat/SKILL.md` — describes when to reach for the tool
(referencing a past chat in this project, summarizing/searching it) and the
two-mode usage. Auto-registered by the existing `config` hook (skills dir is
already on `skills.paths`).

## Error handling

- No `ctx.sessionID` → throw (same as time_logger).
- Cross-project `session_id` → reject with a clear message.
- Temp session always deleted in `finally`.
- Malformed/empty transcript → return an explicit "empty" result, never throw.
- `lines_only` without keywords → validation error.
```
