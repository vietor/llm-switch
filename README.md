# llm-switch

Local HTTP proxy that forwards LLM requests to an upstream API with format conversion and model override.

## Install

```bash
npm install -g @vietor/llm-switch
```

## Config

Create `~/.llm-switch.json`:

```json
{
  "port": 3456,
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-xxxxxxxx",
  "model": "deepseek-v4-flash"
}
```

| Field | Description |
|-------|-------------|
| `port` | Listen port, defaults to `3456` |
| `baseUrl` | Upstream API base URL (required) |
| `anthropicBaseUrl` | Separate upstream for Anthropic-format requests (optional) |
| `apiKey` | API key (required), overrides request API_KEY |
| `model` | Default model name (required), overrides `model` in every outgoing request |

## Usage

```bash
llm-switch
```

Point your LLM client to `http://localhost:3456` instead of the upstream API. The proxy accepts these request formats:

### Chat Completions (`/chat/completions`)

Standard OpenAI Chat Completions format — proxied directly with no conversion. The `model` field is overridden to the configured value.

```bash
curl http://localhost:3456/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ignored",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Anthropic SDK Messages (`/anthropic/v1/messages`)

Accepts Anthropic SDK message format. System messages embedded in the `messages` array are extracted into the top-level `system` field before forwarding.

```bash
curl http://localhost:3456/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-..." \
  -d '{
    "model": "ignored",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

If `anthropicBaseUrl` is configured, requests to `/anthropic/*` are forwarded there with the `/anthropic` prefix stripped (e.g. `/anthropic/v1/messages` → `{anthropicBaseUrl}/v1/messages`).

### OpenAI Responses API (`/responses`)

Converts OpenAI Responses API format to Chat Completions before forwarding. Supports both non-streaming and streaming responses.

```bash
curl http://localhost:3456/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ignored",
    "input": "Hello"
  }'
```

For streaming, add `"stream": true` — the proxy converts the upstream Chat Completions SSE stream into Responses API SSE events (`response.output_text.delta`, `response.done`).

## How it works

All requests go through these transformations:

1. **Format conversion** — Anthropic SDK and Responses API formats are converted to Chat Completions format
2. **Model override** — The `model` field in every outgoing request is replaced with the configured value
3. **Forwarding** — The converted request is sent to the upstream API and the response is passed back, with reverse conversion for Responses API responses
