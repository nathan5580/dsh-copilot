# dsh-copilot

Use your **GitHub Copilot subscription** as a model provider in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-copilot` is an OpenAI-compatible LLM adapter plus a profile bundle. It registers a
`copilot` provider route on `ctx.llm` and points the default model at it, so once it is
installed the harness talks to Copilot instead of DeepSeek. It streams (SSE), supports tool
calls and reasoning, and maps provider errors to the harness's stable failure codes.

> **How it works:** GitHub's Copilot endpoint is OpenAI-compatible, but getting a token
> requires GitHub's OAuth device flow plus a ~20-minute JWT refresh loop. Rather than
> reimplement that here, this plugin points at a **local Copilot proxy** (the recommended
> [`copilot2api`](https://github.com/whtsky/copilot2api)) that already owns auth and token
> refresh. The plugin speaks plain `/v1/chat/completions`, so it also works directly
> against `https://api.githubcopilot.com` if you supply your own token (see
> [Native mode](#native-mode-no-proxy)).

---

## Quick start

### 0. Prerequisites

- Node.js `^22.19 || >=24` and the `dsh` CLI.
- A GitHub Copilot subscription.
- A Copilot proxy — this guide uses `copilot2api`.

### 1. Run the proxy

```sh
# macOS Apple Silicon release binary (pick your platform on the releases page)
curl -L -o copilot2api \
  https://github.com/whtsky/copilot2api/releases/latest/download/copilot2api-darwin-arm64
chmod +x copilot2api
./copilot2api
```

On first run it prints a device code: open <https://github.com/login/device>, enter the code,
approve, and it starts serving on `http://127.0.0.1:7777`. It needs no API key (any bearer
token is accepted) and stores your GitHub credentials locally at
`~/.config/copilot2api/credentials.json`.

> ⚠️ Keep it local-only. This proxy accepts any request on `127.0.0.1` — do not expose it.

### 2. Install the plugin into a profile

```sh
# From this repo (recommended until published to npm)
dsh plugin --profile headless add github:nathan5580/dsh-copilot

# Or, if it is published to npm:
# dsh plugin --profile headless add dsh-copilot
```

`dsh plugin add` runs `pnpm add` in the profile directory, then detects this package's
`dsh.bundle` manifest and adds it to the profile's bundle layers, so its patch is applied
automatically. No hand-editing of `cordis.yml` is required.

### 3. Run a task

```sh
dsh --profile headless "summarize the file README.md"
```

The bundle patch sets the default model to `copilot` / `gpt-5.6-luna`. Change it (or pick a
different model per session) if you prefer another model.

---

## Configuration

The plugin reads its config from its `cordis.yml` entry (the bundle patch sets it for you).
Every field is optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:7777/v1` | Endpoint base; `/chat/completions` is appended. Use `https://api.githubcopilot.com` for native mode. |
| `apiKeyEnv` | `COPILOT_API_KEY` | Environment variable holding the bearer token. The local proxy ignores it. |
| `apiKey` | — | Literal bearer token override (wins over `apiKeyEnv`); for native mode. |
| `reasoningEffort` | — | `off` \| `low` \| `medium` \| `high`; `off` omits the wire field. |
| `maxTokens` | `16384` | Default per-request output cap; explicit request values win. |
| `defaultContextWindow` | `200000` | Context capacity used when a model has no exact value. |
| `models` | a small built-in list | Advisory catalog shown to discovery consumers; requests accept any id. |
| `streamIdleTimeoutMs` | `300000` | Max provider idle time while a stream read is outstanding. |

Override in your profile's `cordis.patch.yml`:

```yaml
- id: llm-copilot
  config:
    baseURL: https://api.githubcopilot.com
    apiKeyEnv: COPILOT_API_KEY
```

Or change the default model:

```yaml
- id: agent-default-model
  config:
    provider: copilot
    model: claude-opus-4.6
```

### Finding current model ids

Copilot's model ids churn. List the ids the proxy currently exposes:

```sh
curl -s http://127.0.0.1:7777/v1/models
```

Then set the id you want in `agent-default-model` (or select it in the Web Models page).

---

## Native mode (no proxy)

If you prefer to talk to Copilot directly, point `baseURL` at
`https://api.githubcopilot.com` and supply a real Copilot bearer token via `apiKey` or
`apiKeyEnv`. Obtaining and refreshing that token (GitHub device flow →
`https://api.github.com/copilot_internal/v2/token`, refreshed every ~20 minutes) is outside
this plugin — that is exactly what the proxy automates.

---

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # build + vitest (mock OpenAI-compatible SSE server)
npm run build       # emit lib/ (committed, so git installs need no build step)
```

The transport mirrors the harness's own DeepSeek adapter: `src/serialize.ts` (messages →
wire), `src/sse.ts` (SSE framing), `src/translate.ts` (wire deltas → harness chunks), and
`src/adapter.ts` (the `LlmAdapter`). `src/index.ts` is the function plugin
(`name` / `inject` / `Config` / `apply`).

---

## License and responsibility

MIT. Using your Copilot subscription through a third-party proxy may conflict with GitHub's
terms of service — that is your responsibility to review. This project is not affiliated with
GitHub or DeepSeek.
