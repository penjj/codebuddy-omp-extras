# codebuddy-omp-extras

Reusable extras for driving [CodeBuddy](https://codebuddy.ai) through [oh-my-pi](https://github.com/earendil-works/oh-my-pi) (omp): a credit-usage extension and a metadata patch for the `pi-codebuddy-sdk` provider.

## What's inside

- **`codebuddy-usage/`** — an omp extension that reports real CodeBuddy credit consumption by reading the per-request `credit` the CLI already persists to disk. No API keys, no network.
- **`patches/real-model-metadata.patch`** — fixes the CodeBuddy provider's model list so every CodeBuddy-hosted model shows correct token limits, a credits multiplier, and image/reasoning capability flags (instead of being reported as text-only / "free").
- **`docs/session-resume.md`** — how the CodeBuddy provider resumes sessions in `pi-codebuddy-sdk`, and how to debug "context lost every turn" issues.

## Privacy

Everything here only reads **your own local** files (`~/.codebuddy/traces`, `~/.codebuddy/projects`, the CLI's bundled product tables). Nothing is sent anywhere. No personal paths, tokens, conversation contents, or credentials are included in this repo.

## 1. `codebuddy-usage` extension

### Install

```bash
cp -r codebuddy-usage ~/.omp/agent/extensions/codebuddy-usage
# then restart omp
```

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

### Apply

```bash
cd ~/.omp/plugins/node_modules/pi-codebuddy-sdk
patch -p1 < /path/to/patches/real-model-metadata.patch
```

Re-apply after any `pi-codebuddy-sdk` update (the patch is a plain unified diff against `src/models.ts` and `src/index.ts`).

## 3. Session resume & debugging

See [`docs/session-resume.md`](docs/session-resume.md).

## License

MIT — see [LICENSE](LICENSE).
