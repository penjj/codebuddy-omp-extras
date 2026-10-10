# codebuddy-omp-extras

Reusable extras for driving [CodeBuddy](https://codebuddy.ai) through [oh-my-pi](https://github.com/earendil-works/oh-my-pi) (omp): a credit-usage extension and a metadata patch for the `pi-codebuddy-sdk` provider.

## What's inside

- **`codebuddy-usage/`** — an omp extension that reports real CodeBuddy credit consumption by reading the per-request `credit` the CLI already persists to disk. No API keys, no network.
- **`patches/real-model-metadata.patch`** — fixes the CodeBuddy provider's model list so every CodeBuddy-hosted model shows correct token limits, a credits multiplier, and image/reasoning capability flags (instead of being reported as text-only / "free").
- **`patches/session-bare-user-resume.patch`** — fixes "every turn loses context" in omp multi-turn conversations: the host sends only the latest user message per turn, so the provider clean-started a fresh CLI session each time. The patch resumes the live session instead — **and** fixes the resulting cross-session bleed (`clearSession()` was dead code because `SessionStartEvent` has no `reason` field; resume is now also gated by an idle timeout).
- **`docs/session-resume.md`** — how the CodeBuddy provider resumes sessions in `pi-codebuddy-sdk`, the root-cause analysis of the context-loss bug, and how to debug it.

## Privacy

Everything here only reads **your own local** files (`~/.codebuddy/traces`, `~/.codebuddy/projects`, the CLI's bundled product tables). Nothing is sent anywhere. No personal paths, tokens, conversation contents, or credentials are included in this repo.

## 1. `codebuddy-usage` extension

### Install

```bash
cp -r codebuddy-usage ~/.omp/agent/extensions/codebuddy-usage
# then restart omp
```

### Live status bar

The extension also pushes a line into omp's **footer status bar** (the same row
as the built-in `⚡ t/s` / context stats), so you see credits without typing
anything:

```
会话 12.34 cr · 剩余 987.66/1000.00 cr
```

It refreshes on `session_start` and after each turn (throttled to once per 10s),
and immediately after any `/cb-usage` command — so `/cb-usage quota 10000`
updates the bar right away. Until you set a quota it reads
`会话 … · 合计 … · /cb-usage quota <总积分>`; until the first scan it reads
`cb-usage: 未扫描 · /cb-usage scan`.

If your omp build doesn't expose `ctx.ui.setStatus`, the extension silently
skips this and the commands below still work.

### Commands

| Command | What it shows |
|---|---|
| `/cb-usage` | Summary: total, today, current session, top models, recent days |
| `/cb-usage now` | **当前会话积分** + remaining / total (needs quota) |
| `/cb-usage total` | Lifetime credits + call count |
| `/cb-usage today` | Credits for the current day |
| `/cb-usage model [q]` | Credits grouped by model (substring filter) |
| `/cb-usage day [YYYY-MM-DD]` | Credits for one day |
| `/cb-usage recent [n]` | Last n sessions with their totals |
| `/cb-usage quota [n]` | Show or set your total credit allotment (cr) |
| `/cb-usage rate` | Static per-model credit multiplier (from product tables) |
| `/cb-usage scan` | Force a full re-index of trace files |
| `/cb-usage clear` | Drop the local ledger cache |

### How credits are counted (and why it's a lower bound)

The `credit` for a request is **not** in its own response — it only appears
inside `usage` blocks carried in the *next* request's `toolInput` (the full
prompt, which replays every earlier assistant message). Two consequences:

1. **Every span re-embeds all earlier credits.** Summing one credit per span
   counts old requests over and over. An earlier version of this extension took
   the *first* match per span and reported **2691 cr**; after de-duplicating by
   the identity of each usage block (`inputTokens|outputTokens|cached|credit`)
   the same data yields **76.80 cr across 577 unique calls**.
2. **`toolInput` is truncated at ~100 KB by the CLI.** Long conversations lose
   their later usage blocks, so recent requests are under-counted. Measured
   coverage on a real machine: **14 579 generation spans exist, but only 577
   distinct usage blocks survive** (~4%).

So the number is a **lower bound** — fine for trend and magnitude, not a bill.
The summary prints a warning saying so.

Alternative sources checked and rejected: `toolOutput` has complete token
counts but **no** `credit`; the CLI log records tokens only; and
`product.cloudhosted.json` lacks the models omp actually uses (hy4-preview,
hy3, deepseek-v4.1-flash) and doesn't state its multiplier's unit.

### Where the numbers come from

Each model call the CodeBuddy CLI makes is recorded as an OpenTelemetry trace under `~/.codebuddy/traces/<pid>/trace_<id>.json`. Each trace has a `generation` span whose `toolInput` carries the real `credit` the request cost:

```json
{ "model": "deepseek-v4.1-flash", "credit": 0.92,
  "usage": { "inputTokens": 34448, "outputTokens": 200, "totalTokens": 34648 } }
```

That `credit` is the server-computed cost — the same number you would get by "querying the interface" after a session. The extension just reads it. Results are cached in a ledger keyed by each trace file's mtime, so repeat runs are fast.

### Current session & remaining / total

- **当前会话积分** is attributed by time: the active session is the newest `~/.codebuddy/projects/<hash>/<id>.jsonl`; generations recorded at/after its first-message timestamp count as the current session.
- CodeBuddy exposes **no balance / quota API**, so "remaining / total" is derived from a user-set allotment. Run `/cb-usage quota 1000` (your total credit package, in cr); the extension then shows `剩余 = 配额 − 已消耗`.

## 2. `real-model-metadata` patch

The `pi-codebuddy-sdk` provider only reports token limits and capabilities from id-based heuristics, so every CodeBuddy-hosted model shows up as text-only with `cost: 0` ("free"). This patch recovers the real values from the CLI's own copy of its last server payload (its `local_storage` cache, else the model table bundled with the CLI install).

### Apply (both patches, in order)

```bash
cd ~/.omp/plugins/node_modules/pi-codebuddy-sdk
patch -p1 < /path/to/patches/real-model-metadata.patch      # 1. model metadata
patch -p1 < /path/to/patches/session-bare-user-resume.patch # 2. multi-turn context fix
```

Re-apply after any `pi-codebuddy-sdk` update (plain unified diffs against `src/`).

## 3. Multi-turn context fix (`session-bare-user-resume.patch`)

**Symptom:** in an omp conversation with a CodeBuddy model, every new message acts like the first one — the model "forgets" everything.

**Root cause (verified from CLI logs, 2026-10-11):** omp sends ONLY the latest user message to the provider on normal turns (no transcript). `syncSharedSession` saw an empty history and took the clean-start path → no `--resume` flag → the CodeBuddy CLI spawned a brand-new session per turn. Special flows (title generation, session recap) DO pass the full transcript, which is why those worked while normal chat didn't. The bundled CLI inside `@tencent-ai/agent-sdk` (not the globally installed `codebuddy`) serves omp sessions, so upgrading/downgrading the global CLI changes nothing.

**Fix:** when the provider receives a bare user message and already owns a live session for the cwd, resume it — the session's JSONL on disk carries the full history.

**Second bug this patch also fixes — cross-session bleed.** Resuming blindly made a *new* conversation adopt the *previous* conversation's session and import its history. Two defects: (a) the SDK's `session_start` handler gated `clearSession()` on `event.reason`, but `SessionStartEvent` carries only `type` — omp emits `{type:"session_start"}` — so the guard never fired and `sharedSession` survived every session switch; (b) with no transcript nothing proves the cached session is the one on screen. The patch clears on `session_start` / `session_before_switch` / `session_switch`, and refuses to resume a session idle longer than `CODEBUDDY_SDK_RESUME_MAX_IDLE_MS` (default 2 h).

Still unfixed upstream in `pi-codebuddy-sdk@0.4.23`; the fork `@raoxxxwq/pi-codebuddy-sdk@0.7.1` shares the same code lineage and the same gap.

## 4. Session resume internals & debugging

See [`docs/session-resume.md`](docs/session-resume.md).

## 5. Verification (`tests/`)

These load the **real** patched modules (via the SDK's exported `__test` hooks)
and drive them with the exact event payloads omp sends — they are not
re-implementations of the logic.

```bash
bun tests/verify-session-fix.ts     # Case 5 idle gate / cwd / reentrancy guards
bun tests/verify-session-clear.ts   # session_start really clears the session
bun tests/verify-status-bar.ts      # the credit line reaches ctx.ui.setStatus
```

Override the module locations with `OMP_HOME`, `CB_SDK_ENTRY`,
`CB_USAGE_ENTRY`.

### Proving the session fix, not just asserting it

Running the unpatched baseline through the same test is what shows the bug was
real. Point `CB_SDK_ENTRY` at a pristine `pi-codebuddy-sdk@0.4.19` checkout:

```
registered handlers: session_start, session_shutdown, ...   (no *_switch)
FAIL   sharedSession cleared on session_start   {"sessionId":"STALE-prev-convo",...}
```

Same test against the patched SDK:

```
registered handlers: session_start, session_before_switch, session_switch, ...
PASS   sharedSession cleared on session_start
```

That stale surviving session is exactly what let a new conversation resume the
previous one's history.

### Known limitation: credit data lags

Traces are flushed only when the CodeBuddy CLI subprocess exits, so during a
long omp session the newest record can be hours old and the session figure may
read `0.00`. The status line appends `·数据 MM-DD HH:mm` whenever the newest
entry is more than 30 minutes old, so a stale number is never shown silently.

## License

MIT — see [LICENSE](LICENSE).
