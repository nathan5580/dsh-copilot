# dsh-copilot

Use your **GitHub Copilot subscription** as a model provider in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-copilot` is an OpenAI-compatible LLM adapter **and** a profile bundle. Installing it
registers a `copilot` provider route on `ctx.llm` and points the default model at it, so the
harness talks to Copilot instead of DeepSeek. It streams (SSE), supports tool calls and
reasoning, and maps provider errors to the harness's stable failure codes.

> **How it works.** GitHub's Copilot endpoint is OpenAI-compatible, but obtaining a token
> requires GitHub's OAuth device flow plus a ~20-minute JWT refresh loop. Rather than
> reimplement that here, this plugin points at a **local Copilot proxy** (the recommended
> [`copilot2api`](https://github.com/whtsky/copilot2api)) that already owns auth and token
> refresh. The plugin speaks plain `/v1/chat/completions`, so it also works directly against
> `https://api.githubcopilot.com` if you supply a token (see
> [Native mode](#native-mode-no-proxy)).

```
dsh (harness)  ->  dsh-copilot (adapter)  ->  copilot2api (local proxy)  ->  api.githubcopilot.com
```

---

## Quick start

### 0. Prerequisites

- Node.js `^22.19 || >=24`.
- The `dsh` CLI at version `0.1.0-rc.6` or newer (the harness's `next` line; check with
  `dsh --version`).
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
automatically. No hand-editing of `cordis.yml` is required. The committed `lib/` means the
git install needs no build step and no `prepare` script to allowlist.

### 3. Run a task

```sh
dsh --profile headless 'summarize the file README.md'
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
| `apiKeyEnv` | `COPILOT_API_KEY` | Credential reference (env-var name); resolved per request through the credential store, then the environment. The local proxy ignores it. |
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

### Web Models page

Because the plugin registers a settings section, the Models page shows `copilot` with an
inline form for `baseURL`, `apiKeyEnv`, `reasoningEffort`, `maxTokens`, `models`, and the
other fields. Saving it writes the `llm-copilot:` section of `$DSH_HOME/settings.yaml`,
hot-reloaded without restart — the same place the form writes for DeepSeek. `apiKeyEnv` is a
credential reference, resolved per request through the credential store (also editable on the
page), then the environment.

### Finding current model ids

Copilot's model ids churn. List the ids the proxy currently exposes:

```sh
curl -s http://127.0.0.1:7777/v1/models
```

Then set the id you want in `agent-default-model` (or select it in the model picker).

### Image input

Models that expose vision, including `gpt-5.6-luna`, accept harness image attachments.
The adapter reads durable images through `ctx.attachments` and sends them as
OpenAI-compatible `image_url` data URLs. The attachment service must be installed
and active in the harness profile.

---

## Native mode (no proxy)

Point `baseURL` at `https://api.githubcopilot.com` and supply a real Copilot bearer token
via `apiKey` or `apiKeyEnv`. Obtaining and refreshing that token (GitHub device flow →
`https://api.github.com/copilot_internal/v2/token`, refreshed every ~20 minutes) is outside
this plugin — that is exactly what the proxy automates.

---

## Known limitations

- **No built-in token refresh.** Proxy mode delegates auth to the proxy; native mode expects
  you to supply and refresh the JWT yourself.
- **The model catalog is advisory.** Copilot's ids are undocumented and change frequently; the
  built-in list is a convenience, and requests are never rejected for using an unlisted id.

---

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:7777`** — the proxy is not running. Start `copilot2api` first.
- **the `copilot` provider is missing** — the bundle layer was not added. Re-run
  `dsh plugin --profile <name> add github:nathan5580/dsh-copilot` and check that
  `dsh.profile.bundles` in the profile's `package.json` lists `dsh-copilot`.
- **an unknown-model / 404 error from Copilot** — the model id is stale. Run
  `curl -s http://127.0.0.1:7777/v1/models` and update `agent-default-model`.
- **pnpm blocks a build script** — this package ships no `prepare` script, so a normal
  `dsh plugin add` needs no `allowBuilds` entry. If your pnpm version still prompts for a
  git dependency, add the printed key to `pnpm-workspace.yaml` in the profile directory.

---

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # build + vitest (mock OpenAI-compatible SSE server)
npm run build       # emit lib/ (committed, so git installs need no build step)
```

Layout: `src/serialize.ts` (messages → wire), `src/sse.ts` (SSE framing),
`src/translate.ts` (wire deltas → harness chunks), `src/adapter.ts` (the `LlmAdapter`),
and `src/index.ts` (the function plugin: `name` / `inject` / `Config` / `apply`). The
transport mirrors the harness's own DeepSeek adapter, so the wire protocol is proven.

---

## License and responsibility

MIT. Using your Copilot subscription through a third-party proxy may conflict with GitHub's
terms of service — that is your responsibility to review. This project is not affiliated with
GitHub or DeepSeek.
