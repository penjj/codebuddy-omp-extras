# CodeBuddy provider session resume (`pi-codebuddy-sdk`)

When omp drives CodeBuddy through `pi-codebuddy-sdk`, every user turn calls
`syncSharedSession(messages, cwd, ...)`. That function decides whether to
**reuse** the previous CodeBuddy session (so the model keeps its context) or
**start / rewrite** a session. The decision hinges on an in-process global,
`sharedSession` (`let sharedSession: SessionState | null = null`).

## The four cases

| Case | Condition | Result | Context kept? |
|---|---|---|---|
| 3 — reuse | `sharedSession` present, no missed messages | resume existing session | ✅ full |
| 1 — clean start | `priorMessages.length === 0` | `sessionId: null` (no resume) | ❌ model sees only the latest message |
| 4 — rebuild | `sharedSession` null but history present | delete + recreate session from history | ⚠️ depends |
| 1-synthetic | history shrank below cursor | rebuild from truncated history | ⚠️ |

Both call sites pass the **full conversation transcript**
(`readTranscript(context)` / `[...context, userPrompt]`), so when
`sharedSession` is alive, reuse (Case 3) works and the session accumulates
messages normally.

## Symptom: "every turn loses context / creates a new session"

This happens when the model receives only the latest user message with no
`resume`. Two root causes:

1. **`sharedSession` is lost between turns** — it is an in-process global. If
   the host reloads the SDK module / respawns the process per message, it resets
   to `null` every turn, forcing a fresh session each time.
2. **The provider is given only the latest message** (not the full transcript)
   — then `priorMessages.length === 0` → Case 1 clean start → no resume.

This resume mechanism is **unique to the CodeBuddy provider**; other providers
(Claude / GPT) keep history natively in their own SDK / API, so they are immune.

## Root cause verified (2026-10-11): the bare-user contract

 omp sends **only the latest user message** to the provider on normal
conversation turns — no transcript. Evidence, all from one repro (greeting →
"what did you just say?"):

- The CLI's own log (`~/.codebuddy/logs/<date>/<workspace>__<hash>.log`) records
  the full argv per request. Normal turn 2 arrived **without `--resume`**, while
  the title-generation and session-recap side queries arrived **with
  `--resume`**.
- The SDK spawns a fresh CLI process per request. Without `--resume` the CLI
  creates a brand-new time-ordered session id each turn — hence "new session
  every message".
- `syncSharedSession` only omits `resume` when `priorMessages.length === 0`
  (Case 1), which proves the incoming context held exactly one message.
- The session-recap flow imports the full 4-message transcript into the session
  and resumes it successfully — proving the resume machinery itself works when
  the host supplies history.

**Also verified:** omp sessions run on the CLI **bundled inside
`@tencent-ai/agent-sdk`** (`cli-resolver.js` prefers the bundled copy over the
global install). Upgrading or downgrading the globally installed
`@tencent-ai/codebuddy-code` has no effect on omp sessions.

## The fix (Case 5)

`patches/session-bare-user-resume.patch` adds a case to `syncSharedSession`:
when the incoming context is a bare user message (no transcript) and a live
session already exists for the cwd (and the call is not reentrant), **resume
that session** instead of clean-starting. The session's JSONL on disk carries
the accumulated history — the CLI appends its own replies — so the model keeps
its context.

Known trade-offs:

- A brand-new omp conversation started inside the same omp process would
  wrongly resume the previous conversation's CLI session (the SDK has no
  signal distinguishing them). omp typically runs one conversation per process,
  so in practice this is rare.
- omp-side history rewrites (compact, forks) that arrive as full transcripts
  still flow through the existing REBUILD path, which rewrites the session from
  the host's view — unchanged behavior.

## Debugging

The SDK logs every decision when `CODEBUDDY_SDK_DEBUG=1`:

```bash
CODEBUDDY_SDK_DEBUG=1 omp ...
# then read
tail -f ~/.pi/agent/codebuddy-sdk.log | grep -E "syncResult|Case"
```

Interpretation:

- `syncResult: path=reuse sessionId=...` every turn → resume is fine; the bug is
  upstream (provider not given full context).
- `path=clean-start` or `path=rebuild ... new session` every turn →
  `sharedSession` is being reset (host reload / module re-instantiation).

> Note: `syncSharedSession` lives in `pi-codebuddy-sdk`, **not** in the
> `codebuddy-code` CLI — and omp sessions don't even use the globally installed
> CLI: `@tencent-ai/agent-sdk` spawns its own bundled copy. Downgrading the
> global CLI changes nothing for omp. The debug log above is what pins bugs
> down.
