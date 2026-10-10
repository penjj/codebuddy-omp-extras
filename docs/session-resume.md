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
> `codebuddy-code` CLI. Rolling back the CLI changes the CLI's `resume` handling
> but not this function — so if the bug is in the SDK, a CLI downgrade will not
> fix it; the debug log above is what pins it down.
