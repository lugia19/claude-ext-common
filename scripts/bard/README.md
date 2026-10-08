# bard: claude.ai's merged-experience API

Accounts with the merged chat/Cowork experience don't use the old JSON chat endpoints
(`/completion`, the post-message tree GET). The web client speaks **Connect-RPC with binary
protobuf** to `POST /claudeai-rpc/anthropic.bard.api.v1alpha.<Service>/<Method>`.

This folder holds the tooling to extract the API's schema from the live bundle, decode captured
traffic, and a snapshot of the schema (`descriptors.json`, rendered under `proto/`) so changes show
up as diffs. **Re-extract before changing any code that reads this API**: it's `v1alpha` and moves.

## Tooling

Works from an extension's `common/` submodule or a standalone clone. `node_modules/` and
`captures/` are gitignored, and `check-common.js` lets ignored files under `scripts/` through,
since no build packs `common/scripts/**`.

```bash
cd common/scripts/bard   # or scripts/bard in a standalone clone
npm ci                   # @bufbuild/protobuf, dev only
```

1. **Dump the schema.** In a logged-in claude.ai tab with a conversation open, run
   `page/dump-descriptors.js` (chrome-devtools MCP `evaluate_script`, or paste into the console)
   and save the returned JSON as `descriptors.json`. protobuf-es embeds every `.proto` in the bundle
   as a base64 `FileDescriptorProto`, field names included. Only loaded chunks are scanned.
2. **Render it.** `node render-protos.mjs` rewrites `proto/` from `descriptors.json`, and
   `node gen-schema.mjs` rewrites `net/bard-schema.js` (the table `ClaudeExtNet.decodeBard` reads,
   bumping its `VERSION` if it changed). Commit all three. To decode another call's messages at
   runtime, add its request/response to `ROOTS` in `gen-schema.mjs`.
3. **Capture traffic.** Install `page/capture-hook.js` before the page's code runs (MCP
   `navigate_page({ type: 'reload', initScript })`), drive the UI, then export `window.__recon`
   (see the file's header). Captures go in `captures/`, which is gitignored: they hold request
   bodies.
4. **Decode it.** `node decode-capture.mjs captures/x.json --compact --out captures/x.decoded.json`,
   then `node timeline.mjs captures/x.decoded.json` for one line per action and stream event.
5. **Check the runtime decoder.** `node check-decoder.mjs` decodes every captured message with
   `net.js`'s `decodeBard` and with protobuf-es, and fails on any difference; it also tests
   `readConnectFrames` on the captured streams (cut into random chunks) and that older copies of
   `net.js` / `bard-schema.js` loading later change nothing. Run it after regenerating the schema
   or touching the decoder.

Gotchas the scripts already handle:
- protobuf-es strips each embedded descriptor's `dependency` list, its own well-known types
  included. `registry.mjs` rebuilds the imports from referenced type names.
- The embedded descriptors have an empty `json_name`, so decode with `useProtoFieldName`.
- Streaming frames are `flags(1) + length(4, BE) + payload`. Flag `0x01` = gzip payload,
  `0x02` = end-of-stream (JSON trailers, e.g. `Stream-Close-Reason: cadence`).
- Unary calls are plain `application/proto`. Streaming calls are `application/connect+proto`.

## What we know (recon 2026-10-06, all extensions disabled)

### Calls

| RPC | When | Notes |
| --- | --- | --- |
| `ConversationService/GetNewConversationDefaults` | `/new` | Work mode, settings defaults, upload limits |
| `ConversationService/PerformAction` (unary) | every user action | `PerformActionRequest { header: ActionHeader, oneof action }`. Empty response body. The answer comes back on the stream |
| `ConversationService/StreamTimeline` (server stream) | page load, and kept open | Everything about the conversation, see below. Closes on a cadence and the client reopens it with `version` = last seen |
| `ConversationService/ReportViewing` | after a send / on view | `{ refresh_after_seconds: 45 }` |
| `ConversationService/ReadConversationHistory` | scrolling up | Pages older messages with `older_history_cursor` |

`PerformAction` cases captured:
- `warm_turn { intended_send { ... } }`: sent just before a send (and on attaching a file).
- `send_message { message_id, assistant_message_id, text, model?, settings_update?, parent_message_id?, input_mode, inline_attachments, timezone, locale, client_platform }`.
  The client picks **both** UUIDs up front, like `turn_message_uuids` on the old `/completion`.
  The conversation UUID is client-made too, for a new chat. `model` and `settings_update` only
  ride along on a new conversation; afterwards **read the model from the stream's
  `conversation.model`**, not from the send.
  - **Retry**: `input_mode: INPUT_MODE_RETRY`, `parent_message_id` = the human message, new
    `assistant_message_id`, no text.
  - **Edit**: new text, with `parent_message_id` = the assistant message before the edited one.
  - **Text attachments** go inline: `inline_attachments[{ file_name, file_size, file_type,
    extracted_content }]`, with no upload call, up to `inline_attachment_max_accepted_bytes`
    (4MB, from `GetNewConversationDefaults`). A 1MB text file made a 1MB `PerformAction`.
  - **Binary files** (PDF, images) go up first through the legacy XHR
    `POST /api/<org>/upload` (FormData `file` + `client_upload_id`), then are referenced in
    `send_message.attachments[{ id, file_name, file_size, media_type }]`.
- `stop_generation {}`. Acked with `stop_generation_effect: STOP_GENERATION_EFFECT_TURN_CANCELED`.
- `set_conversation_model { model { identifier } }`, also with a legacy `PATCH /api/account/settings`.
- `update_conversation_settings { settings { thinking_mode_token: "off" | "auto" | "extended" } }`
  (the Haiku "Extended" toggle). Effort is `effort_level_token` in the same settings.
- `set_current_leaf` (branch switch) is in the schema, but the merged UI has **no branch
  switcher**: messages with several versions only offer Retry / Edit / Copy.

### StreamTimeline events (`StreamEvent.event` oneof)

- `update` (`ConversationUpdate`): `conversation`, `messages`, `display_groups`, `content_blocks`,
  `deleted_*_ids`, `older_history_cursor`, `replace_all_state`. Sent as partial upserts keyed by id.
  - **Message**: `id, role (ROLE_USER/ROLE_ASSISTANT), index, parent_message_id, created_at,
    is_complete, stop_reason`. The tree is still there.
  - Content hangs off messages: `Message ← DisplayGroup(message_id) ← ContentBlock(display_group_id)`.
    Text lives in `content_blocks[].text`.
  - **Conversation**: `status (STATUS_IDLE/RUNNING)`, `live_status`, `current_leaf_message_id`,
    `status_user_message_id`/`status_assistant_message_id`, `last_settled_at`, `model.identifier`,
    `settings` (`effort_level_token`, `thinking_mode_token`, web search, the MCP tool map, ...).
    **Effort is visible here**: the old UI had it only in the DOM.
- `append` (`ContentBlockAppend`): `text_delta` for a content block, plus `thinking_summary`,
  `thinking_token_estimate`, citations.
- `message_limit` (`MessageLimit`): **same `windows` shape as the old completion SSE**
  (`5h`, `7d`, `overage`, each `{ status, resets_at, utilization 0..1 }`). Arrives once per turn,
  right before the settle update. It also has optional `context_breakdown`
  (`ContextBreakdown { used_tokens, window_tokens, categories[kind, tokens], attribution
  ESTIMATED|MEASURED, auto_compact_threshold_tokens }`, not seen yet) and `model`.
- `mutation_accepted` / `mutation_ack`: the server took a `PerformAction`.
- `heartbeat` every ~100ms while running and periodically while idle.
- Also: `error`, `model_fallback`, `model_change`, `conversation_deleted`, `composer_notices_changed`.

**A turn settles** with an `update` where the conversation goes `STATUS_IDLE` (with
`last_settled_at`) and the assistant message gets `is_complete: true` and a `stop_reason`. A normal
turn sends `message_limit` just before it. A **stopped** turn sends no `message_limit`, and its
message gets `STOP_REASON_USER_CANCELED`. So key off the settle, not `message_limit`.

**Model and settings changes** arrive as conversation updates (`model.identifier`,
`settings.thinking_mode_token`, `settings.effort_level_token`), on load and whenever they change.

**Tool use** (web search) streams as a `GROUP_STYLE_TIMELINE` display group with a tool content
block (`tool_display_name`, `input_summary`, `display_content.rich_items`). Citations arrive as
`append.citation_start`/`citation_end`. The raw tool input and result aren't on the stream.

**Attachments** show on the user message as `attachments[{ id, file_name, file_size, media_type,
url: /api/organizations/<org>/files/<id>/contents }]`. There's no extracted text on the stream.

**Thinking text is not sent.** A "Thinking..." timeline block (`thinking_display.started_at`) shows
up while it runs and is then deleted. Only summaries and estimates come down.

### The initial snapshot is partial, and older messages are paged

On load, the first `update` has `replace_all_state: true` and only the **current branch's latest
messages**: 36 of ~2450 in a long chat, with an `older_history_cursor` and
`baseline_floor_message_id`. It never includes off-branch siblings.

Scrolling up calls `ReadConversationHistory { conversation_id, cursor }` (no `limit` sent), which
returns `{ update: ConversationUpdate, older_cursor, outcome: OUTCOME_PAGE }`. The cursor is
`<sig>.<base64url JSON>.<sig>`, with a payload like
`{"f":"v2;lane=native;gen=…","i":<start index>,"l":"en-US"}`. Each page returns the next cursor
with `i` = the lowest index served.
- Pages cover a contiguous `index` range and hold **every message in it, all branches included**
  (412 fork points in the 2,061 messages loaded).
- Page sizes seen: 512, 512, 512, 360, then 32, 32, 33, 32 messages, around 1.3-2MB each for the
  big ones. Paging the whole tree of a 2,450-message chat would take about 5 calls and ~6.5MB.
- **`ReadConversation` returns the whole tree in one call.** It's unary,
  `{ conversation_id, display_language, known_revision_ns?, max_response_bytes? }` →
  `{ outcome: OUTCOME_SERVED | OUTCOME_NOT_MODIFIED, update: ConversationUpdate }`. claude.ai's UI
  doesn't seem to call it, but calling it by hand on a 2,447-message chat returned every message
  and branch (480 fork points) in one 7.2MB response in 2.4s, with no cursor. It's the stand-in for
  the legacy tree GET if that ever goes away (same display-shaped content, see below).
  `known_revision_ns` allows cheap not-modified checks. More on it (2026-10-08):
  - `max_response_bytes` is a **ceiling, not a page size**: set below the conversation's size, the
    call fails with 429 `resource_exhausted` "This conversation is too large to load right now"
    (`RequestTooLargeError`). Unset or large, a 2,942-message chat came back whole (5.7MB, ~1.5s).
  - Connect's **JSON codec works**: `content-type: application/json`, body `{"conversationId": …}`,
    and the response is JSON with camelCase fields (`postTokens`, `createdAt`), so no protobuf is
    needed to call it.
  - **Legacy (non-merged) accounts get 403** `permission_denied` "This feature is not included in
    your current plan".
  - **Extension contexts get 403** `permission_denied` "origin not allowed": the RPC endpoints
    check `Origin`, and a background/extension-page fetch sends `chrome-extension://…`. The legacy
    `/api/` endpoints don't check it. **Only `Origin` is checked**: a Chrome
    `declarativeNetRequest` rule (`declarativeNetRequestWithHostAccess`) setting
    `Origin: https://claude.ai` on the extension's own requests (`initiatorDomains: [extension id]`,
    `urlFilter: '|https://claude.ai/claudeai-rpc/'`) turned the same call into a 200. Where no
    such rewrite exists (Electron), the call has to come from the page (MAIN world).
- Content is display-shaped, but **close to the legacy tree in substance**. Measured on the same
  2,447-message chat:

  | | Legacy tree GET | `ReadConversation` |
  | --- | --- | --- |
  | Size / time | 8.1MB / 1.9s | 7.2MB / 2.4s |
  | Messages, branches, parents | all | all, same UUIDs |
  | Text | `content[type=text]` | `content_blocks[].text`, identical on 2,447/2,447 |
  | Thinking | `thinking` (empty when `thinking_hidden`), `summaries` | block with `thinking_display`: same `text` when legacy has it, same `summaries`, start/end times |
  | Tool input | `tool_use.input` (raw JSON) | `input_summary` (can be truncated) + `input_display.table` rows (full values) |
  | Tool result | `tool_result.content` | block `text` (e.g. bash stdout without the `{returncode, stdout}` wrapper), `result_images`; web search as `display_content.rich_items` (legacy also has only titles and URLs) |
  | Images / files | `files[]` with sizes and dims | `attachments[]` with preview/thumbnail dims |
  | Text attachment | `attachments[].extracted_content` | **only id, name and `/files/<id>/contents` URL**: fetch it (the live stream also gives `file_size`) |
  | Assistant `created_at` | about the end of generation for recent messages | generation start (the two match for older messages) |

  The real gap is text-attachment content. The tool-input JSON is recoverable up to formatting.

### Legacy JSON still answers

- `GET /api/organizations/<org>/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true`
  works for merged conversations, with the whole tree and both branches after a retry, and the same
  message UUIDs as the stream. New keys: `platform: "CLAUDE_AI"`, `workspace_upgraded`,
  `is_wiggle_enabled`, `effective_thinking_mode`. claude.ai itself never calls it now.
  It reflects everything above in the old shapes: `tool_use`/`tool_result` with full content,
  `attachments[].extracted_content`, `stop_reason: user_canceled`, the new model, and
  `settings.thinking_mode`/`effort_level`.
- `GET /api/organizations/<org>/usage` is unchanged.
- Timestamp mismatch: for assistant messages the stream's `created_at` is when generation
  **started**, while the tree's `created_at` is about when it **finished** (seconds later).

### Files, the sandbox, and what's actually in context (2026-10-06, Haiku 4.5)

- **Small files go into context.** A 15KB `.txt` (inline), a 1-page PDF and a 64px PNG (both via
  `/upload`) were answered directly in the first turn, with no tool calls.
- **Oversized text goes to a sandbox, not context.** A 1MB `.txt` was still sent inline
  (`extracted_content`, 1MB `PerformAction`), but the server then **upgraded the conversation to a
  workspace mid-turn**:
  - a `prepare_session` tool call ("Setup"), a Claude Code session polled at
    `/v1/code/sessions/cse_…`, and a `replace_all_state` snapshot;
  - the file placed at `/mnt/user-data/uploads/<name>`, which the model read with `Read`
    (offset/limit), `wc`, `grep` and `sed`. About 7KB of tool output reached the context, not 1MB.
  - Afterwards the legacy tree says `workspace_upgraded: true`.
- **No flag marks an attachment as out of context.** In both formats, the 1MB file has the same
  shape as the in-context 15KB one. The legacy tree even holds the full 1MB `extracted_content`, so
  counting attachments naively would overstate the context by ~250k tokens. Usable signals: the
  turn that carried the file opens with a `prepare_session` tool_use, and/or later tool calls read
  `/mnt/user-data/uploads/<that file name>`. The size threshold isn't known.
- **Tool results stay in context in later turns.** Two turns after a `Read` of lines 19995-19997,
  Haiku quoted all three lines exactly with tools forbidden, including text it could not have
  guessed. Both formats carry the exact `tool_result` text the model got: Claude Code's
  `cat -n` format (`19995\t<line>\n…`). The legacy tree also has the `Read` arguments
  (`input: { file_path, offset, limit }`, `integration_name: "Claude Code"`); `ReadConversation`
  only has `input_summary` (the file name), with the range implied by the line numbers.
  `Bash` calls (`wc`, `grep`, `sed`) work the same way: `input.command`, and a single text part
  holding the complete stdout (identical in both formats, and identical to rerunning the commands
  locally on the same file, apart from trimmed trailing whitespace), plus `is_error`. There's no
  exit code or stderr field, unlike the old chat `bash_tool`'s `{returncode, stdout}` JSON.
  The tracker counts tool results as context since Claude-Usage-Extension#130.
- **Web search results also stay in context, but their content is invisible to us.** With tools
  forbidden, Haiku listed all 10 results of an earlier search in order (it had cited one), adding
  details found in neither the titles nor the URLs (e.g. "Maine Open Lighthouse Day"). The tree's
  `web_search` `tool_result` holds only `{type: "knowledge", title, url, metadata, is_missing}` per
  result, no page text, so that part of the context can only be estimated.
- After the upgrade, the turn-1 15KB file still looked to be in context (quoted without tools, but
  that file's lines are predictable, so it's weak evidence).
- `message_limit` arrived **mid-turn** in the sandbox turn (~10s before the settle). It's
  definitely not an end-of-turn signal.

### Auto-compaction

**Compactions done in the merged experience** (seen 2026-10-07, Opus 4.6, workspace-upgraded chat):
- `ReadConversation`: the compaction is its own **assistant message with no content**, a child of
  the last assistant message, whose `extras` holds
  `{ "@type": "…CompactionDivider", pre_tokens: "146743", post_tokens: "3834" }`, real token
  counts, but what they cover is **unverified**. `post_tokens` is almost certainly the **summary's
  size**, not the whole post-compaction context: the system prompt and tools alone must exceed 4k,
  and a pre-merge summary was 13,205 chars ≈ 3.3k tokens. `pre_tokens` may be the full input (as in
  Claude Code's `preTokens`) or the conversation only; one sample can't tell. The summary text itself
  isn't exposed. Because it's a regular `Message`, it should also arrive in the stream's snapshot
  and updates (the live events weren't captured).
- Legacy tree: the same message is an empty assistant message (`content: []`) with **no**
  `compaction_summary` and no counts. The legacy tree can't see these compactions.

**Compactions from before the merge**, checked on a long chat (2,932 messages, 1,156 on the
current branch) compacted once on 2026-08-21:
- **Legacy tree:** the boundary assistant message (index 390, from 2026-06-19) carries
  `compaction_summary: [{ type: "text", text }]`, 13,205 chars, and its `updated_at` is the
  compaction time. The text opens with `[NOTE: This conversation was successfully compacted…]` and
  names a transcript file (`/mnt/transcripts/<date>-<slug>.txt`) the model can `Read`/`grep`
  afterwards. Everything up to and including that message is replaced by the summary. Later
  messages stay verbatim.
- **`ReadConversation`: no trace at all.** Same message, plain text, nothing in `extras`.
  `CompactionDivider { pre_tokens, post_tokens }` exists in the schema but isn't referenced by any
  field (it's presumably packed into an `Any`), and it doesn't appear on load.
  `STATUS_KIND_RUNNING_COMPACTION` exists for the live status.
- Effect here: about 253k chars summarized into 13k, while about 1.27M chars stay after the boundary.
- So the two eras are recorded in opposite places: pre-merge compactions only in the legacy tree
  (with text), merged-era ones only in `ReadConversation`/the stream (with token counts). Handling
  both means reading both.
- **While it runs** (captured live 2026-10-07): the stream's conversation has
  `status: STATUS_RUNNING`, `status_kind: STATUS_KIND_RUNNING_COMPACTION`,
  `status_detail: "Compacting conversation history..."`. `ReadConversation` doesn't fill in
  `status`/`status_kind`, so use the stream.
- The divider message is created **after** the answer of the turn it preceded (the compaction ran
  first, the reply streamed after, then the divider landed as the reply's child).
- A second compaction in the same chat: `pre_tokens: 196497` (right at Opus 4.6's 200K window,
  so `pre_tokens` is almost certainly the full input, system prompt included),
  `post_tokens: 9916` (the summary grew with the history).

**Live, and what it replaces** (2026-10-08, same chat, Haiku 4.5, triggered with ~40K-token filler
messages):
- Sequence on the stream: `STATUS_RUNNING`, then `STATUS_KIND_RUNNING_COMPACTION`; `message_limit`
  arrives during the compaction; the reply message appears and streams; then **one frame carries
  `STATUS_IDLE`, the reply's end and the divider** (`pre_tokens: 177720, post_tokens: 4441`). A
  fourth one in the same chat: `post_tokens: 2629`.
- The divider has a **higher index than the reply**, so "the highest-index assistant message" of a
  turn is the divider, not the reply. Skip it when looking for the turn's message.
- The opening snapshot includes existing dividers with their extras (only within its window).
- **Everything up to and including the divider is gone**, the compaction turn's own message too:
  asked without tools, the model couldn't quote a line from that turn's 40K message and described
  its context as system prompt, then the summary (with a short "continues from a previous
  conversation" preamble and the "Continue the conversation…" instruction), then later messages.
- **`post_tokens` overstates the summary in context**: the model reproduced the summary (all nine
  sections, 9,590 chars) and it counted 2,525 tokens (Opus 4.6 tokenizer, Haiku 4.5's) / 3,515
  (Opus 4.7's), against `post_tokens: 4441`. Possibly the compaction call's output including its
  stripped `<analysis>` section; unverified.
- **Too big even after compacting**: a 100K-token message on Haiku 4.5 ran the compaction, then
  ended as an empty assistant message with `STOP_REASON_REFUSAL` and no divider; the page shows
  "Paused: This session is too long for this model". In the tree, that refusal is an empty
  assistant message whose parent is the human message (a divider's parent is the reply).

### Fixed overhead, current variant (2026-10-08)

Measured on fresh chats (preferences off, memory off), counted with `count_tokens` (old =
claude-opus-4-6 tokenizer, new = claude-opus-4-7), envelope subtracted. The tracker uses these.

| Section | Old / new | Source |
| --- | --- | --- |
| `claude_behavior` | 4,591 / 6,728 | raw Sonnet 5.5 dump; spot-checked exact |
| `agentic_behavior` | 8,288 / 11,186 | Haiku 4.5 transcription; Opus 4.6's independent one is 99.2% identical (8,162 / 11,028) and spot-checks are exact |
| `search_instructions` (copyright included) | 4,505 / 6,538 | raw dump; spot-checked |
| `using_image_search_tool` | 1,526 / 2,143 | raw dump; spot-checked |
| `citation_instructions` | 585 / 881 | raw dump |
| `end_conversation_tool_info` | 644 / 952 | raw dump; spot-checked |
| `thinking_behavior` | 119 / 169 | raw dump |
| **Behavior text** | **20,258 / 28,597** | |
| 60 loaded tool schemas | ≈ 43,800 / 58,500 | per-tool references (`merged-tool-costs.json`), plus an allowance for the 2 `enable__…` tools with none |
| `available_skills` (22 skills here) | 4,090 / 5,518 | Haiku 4.5 transcription; per-account |
| Trailing text + first-turn reminders | 1,639 / 2,279 | Haiku 4.5: integrations note, repeated intro, date line, deferred names, agent types |
| **Before the first message** | **≈ 70K / 95K** | |
| `preferences_info` | +1,321 / +2,006 | raw dump; only sent when preferences are set |

- **Loaded tools** (asked of Opus 5.5, Sonnet 5.5, Opus 4.6, Fable 5.1 with the environment set up
  first, so no earlier answer to anchor on): the same 60 for all of them, before and after setup.
  The deferred list grows from 12 to 40-44 names after setup. The exception: **some chats switch to
  the Claude Code variant after setup** ("You are Claude Code…", 57 tools: `ListAgents`,
  `ReadNotifications`, `ScheduleWakeup`, `RefreshMcpTools`, `ReportFindings`,
  `ShowOnboardingRolePicker`, `list_repos`, `register_repo_root`, `approximate_location` added; 12
  moved to deferred). Seen on a Fable 5.1 chat and on the 2026-10-06 recon chat, not on fresh
  Opus 4.6 / Opus 5.5 / Sonnet 5.5 chats, so it looks per chat. It's about 7K new-tokenizer
  smaller; the tracker ignores it.
- When asked a second time in the same chat, models tend to repeat their earlier answer instead of
  re-reading; ask once, in a fresh chat.
- Getting the text: Opus 5.5's safeguards pause a verbatim request (`[reasoning_extraction]`),
  Haiku 5.5 and (bluntly asked) Opus 4.6 decline, Haiku 4.5 usually complies with a
  one-section-at-a-time request. Opus 4.6 also complied through the gradual flow of the first
  measurement (estimate, count, write it to files, compare with the dumps), but flattened tool
  schemas and elided parts. Verify any transcription with yes/no spot checks of single sentences
  (include a decoy).
- No data source lists the tools: `SendMessage.client_tools` is unused by the web client, the
  bootstrap carries Cowork's prompts only, and `message_limit.context_breakdown` (which would give
  `SYSTEM_PROMPT` / `TOOL_DEFINITIONS` tokens, measured) has never been sent to us.

### Fixed overhead: the system prompt (2026-10-07)

> **Obsolete variant (2026-10-08).** Everything below was measured in one chat created within hours
> of the account's switchover to the merged experience, and that chat is pinned to an early harness:
> it opens "You are Claude Code…" and has no search/copyright/image-search sections. Fresh chats
> (Opus 5.5 and Haiku 4.5 alike, so not model-dependent) get the current variant: it opens with a
> `<voice_note>` line then `<claude_behavior>`, includes `<search_instructions>` (copyright,
> image search), `<memory_system>`, `<end_conversation_tool_info>`, `<preferences_info>`, puts the
> 60 loaded tool schemas after the behavior text, and keeps `<available_skills>` in the system
> prompt. Setting up the environment doesn't change the system prompt or the loaded tools; it adds
> one turn-level block after the first tool call (environment, model, a 40-name deferred-tool list,
> agent types, MCP server instructions, a second skills list, attribution reminders). Before that,
> the first turn's reminder lists only 12 deferred tools. Re-measure on a current chat before using
> any number below.

The merged experience runs the **Claude Code harness** on claude.ai (the prompt opens "You are
Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."), then the
claude.ai `<claude_behavior>` prose, an `<agentic_behavior>` workspace section, reminders and ~61
loaded tool schemas. Deferred tools (40 here) are listed by name only. Models refuse a direct dump; one
Opus 4.6 chat transcribed it into files, which were then checked against the leaked prompts in
`asgeirtj/system_prompts_leaks` (raw claude.ai Sonnet 5.5, Cowork, Claude Code dumps) and counted
with the real tokenizer (`count_tokens`: old = claude-opus-4-6, new = claude-opus-4-7, envelope
subtracted).

| Part | Old / new tokenizer | Basis |
| --- | --- | --- |
| `claude_behavior` | 6,130 / 8,943 | transcribed; larger than legacy (4,592 / 6,729): extra subsections |
| `search_instructions`, copyright, image-search sections | 0 | not in the merged prompt (its outline + "top 10 results" / CRITICAL_COPYRIGHT probes); an early draft that had them was invented |
| Effort tags + tool-calling framing | ~250 / ~350 | outline + written out on request |
| `agentic_behavior`, misc, reminders, preamble | 12,216 / 16,578 | no reference anywhere; trusted as transcribed |
| 47 tool schemas with a reference | ~31,950 / ~42,550 | reference parameters; core tools = transcribed description + reference parameters |
| 14 tool schemas with no reference | 7,573 / 10,410 | quoted verbatim by Opus 5.5 |
| **Subtotal** | **≈ 58,100 / 78,800** | |
| Skills reminder (per account) | ~2-3K / ~3-4K | not in the dump |
| **Before the user's first message** | **≈ 60-61K / 82-83K** | vs the tracker's `BASE_SYSTEM_PROMPT_LENGTH: 3200` + `FEATURE_COSTS` |

The transcription alone came to 34,804 / 48,263: it flattened tool schemas.

- The shortfall is almost all **parameters**. Across the 46 tools with a reference, descriptions
  came out at 10.9K vs 12.8K (new tokenizer; mostly near-identical text), but parameters at
  **2.7K vs 19.3K**: every schema was flattened to `"param": "short note"` pairs, losing the
  property descriptions, types, enums and nesting.
- The core Claude Code tools (`Agent`, `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`) use
  **older Claude Code wording** (e.g. Grep "A powerful search tool built on ripgrep"), unlike every
  current Claude Code/Cowork dump. Opus 4.6 and then Opus 5.5 (whose training includes the newer
  wording) both quote it from context, so the harness ships it. For these tools the real size is
  the transcribed description plus the reference parameters (≈6.2K new for the seven).
- Opus 5.5 also corrected the framing: the preamble is "You have access to a set of functions you
  can use to answer the user's question. You can invoke functions by writing like the following…"
  plus "Here are the functions available in JSONSchema format:"; only the "If you intend to call
  multiple tools…" paragraph follows the definitions. And there's a **skills list** (~30 skills,
  ~2-3K) in a system reminder on user turns, which varies per account and isn't in the dump.
- Opus 5.5 confirmed the full JSON Schema parameters are in context (its verbatim Edit and Glob
  parameters match the Claude Code dump character for character); the dump flattened them.
- **Deferred tools:** 40 names only (no schemas), in a system reminder on the first user turn (and
  re-sent on the first turn after a compaction), next to agent types, MCP server instructions,
  environment and date: ArtifactComments, ArtifactData, CronCreate/Delete/List, DesignSync,
  Enter/ExitPlanMode, Enter/ExitWorktree, ListConnectors, ListMcpResourcesTool, ListPlugins,
  ListSkills, Monitor, NotebookEdit, PushNotification, ReadMcpResource(Dir)Tool,
  SearchMcpRegistry, SearchSkills, SendMessage, SuggestConnectors, TaskGet/List/Stop, three
  `enable__…` toggles, request_computer, plus per-account MCP tools (here 5 Claude_Docs + 5
  Comfy-v2). A loaded schema arrives as a `ToolSearch` tool_result, so it's countable from the tree.
- After a compaction, the first turn also re-attaches earlier `Read` results, so the post-compaction
  context is system prompt + summary + re-attached reads + reminders.
- The 14 loaded tools with no published reference (WebFetch, WebSearch, TaskCreate, TaskUpdate,
  propose_skills, ReadNotifications, SearchPlugins, SuggestPluginInstall, add_repo, list_repos,
  register_repo_root, current_time, approximate_location, launch_extended_search_task) were then
  quoted verbatim by Opus 5.5: **7,573 old / 10,410 new**, against 3,323 / 4,668 as transcribed
  (descriptions were cut down too, not just parameters).
- **Which tools are deferred can't be read from anything we see.** `conversation.settings
  .tool_search_mode` (`AUTO`/`ON`/`OFF`) has no effect: it was `off` in a chat with 40 deferred
  tools, and a new chat with it changed listed exactly the same ones. Connector tools are deferred
  (even within one server: Claude_Docs had 3 loaded, 5 deferred), and `enabled_mcp_tools` doesn't
  match what's in context. Built-in loaded/deferred sets look fixed per harness version.
- Per-tool costs (both tokenizers, with sources and loaded/deferred defaults) live in the tracker
  as `bg-components/merged-tool-costs.json`, generated from these measurements but not wired in yet.
- **Deferred tool sizes**, from references for 31 of the 40 (new tokenizer): from SendMessage 81 to
  ArtifactData 4,598; mean ≈ 650 old / 860 new, median ≈ 290 / 400. Count a loaded one exactly
  from its ToolSearch result; failing that, use a per-tool table from the references; the mean is
  only for tools with no reference (request_computer, per-account MCP tools). The name list at rest
  is 294 / 421.
- Prompt order: thinking_mode / reasoning_effort tags, tool-calling preamble, the 61 tool
  definitions, calling rules, "You are Claude Code…", `claude_behavior`, `agentic_behavior`,
  misc sections; then system reminders in the first turn (deferred tools, agent types, MCP server
  instructions, environment, model, email, date, git attribution).
- The new tokenizer gives ~1.39× the old one's count on this text.

### Incognito (temporary) chats

Also on the new API (checked 2026-10-07): `/new?incognito`, then `/chat/<uuid>?incognito`.
`send_message.is_temporary: true`. The stream is the same as a normal chat (settle, `message_limit`).
The legacy tree answers with `is_temporary: true` and a smaller settings set (no `paprika_mode` or
`effort_level`). `GetNewConversationDefaults.temporary` gives these chats `WORK_MODE_CHAT` and
more unavailable actions (including `SEND_OUT_OF_CONTEXT_FILES`).

### Projects

Still entirely legacy REST: `POST /api/organizations/<org>/projects` (create),
`PUT /projects/<id>` (instructions), `POST /projects/<id>/docs` (text knowledge, with the content in the
body), `GET /projects/<id>/kb/stats` →
`{ knowledge_size (tokens), max_knowledge_size: 2000000, project_knowledge_search_threshold: 50000,
use_project_knowledge_search }`. Below the threshold, the whole knowledge base is in context. A
project chat sends `send_message.project_id` on its first message, the stream's
`conversation.project_id` carries it, and the legacy tree has `project_uuid`.

### Open questions

- `message_limit.context_breakdown` (or `context_breakdown_json`) feeds a `ChatContextRing`
  component. Neither the ring nor the field has shown up on our account, so it's most likely
  gated by a flag on the server side. If it rolls out, it carries real token counts.
- The size threshold for sending a text file to the sandbox, and whether earlier in-context files
  stay in context after a workspace upgrade.
- Research mode: not captured yet.
- Branch switching: no UI for it found in the merged experience.
