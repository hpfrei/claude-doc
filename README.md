# claude-doc

Inspect every Anthropic API call in real time. Run interactive Claude Code sessions from any browser.

**claude-doc** is two things in one:

1. **An Anthropic API inspector** — a transparent proxy that captures every request, response, SSE event, tool call, and token count flowing between Claude Code and the Anthropic API. See exactly what the wire protocol looks like, in real time, with full payloads you can drill into.

2. **A web-based Claude Code terminal** — send prompts from any browser, get streamed responses, answer interactive questions, and maintain full conversation context — all against a remote machine where Claude Code is running. No SSH, no terminal, just a browser.

I built this to study how Claude Code actually talks to the Anthropic API — what gets sent in each request, how the system prompt is structured, how tool calls stream back, what the token usage looks like. It evolved into my daily tool for running Claude Code on a remote PC from a phone or tablet.

## Features

### API Inspector

```
Browser  --->  Dashboard (:3457)  <--- WebSocket --->  Proxy (:3456)  --->  Anthropic API
                                                          ^
                                                          |
                                                    Claude Code CLI
```

- **Full request/response capture** — every `/v1/messages` and `/v1/messages/count_tokens` call, with headers, payloads, and timing
- **Live SSE event stream** — watch individual server-sent events as they arrive: `message_start`, `content_block_delta`, `message_stop`, and everything in between
- **Tool call extraction** — tool uses are parsed from streaming content blocks and displayed in a hierarchical timeline (turn > tool calls)
- **Token usage tracking** — input, output, cache read, and cache creation tokens per interaction
- **Busy indicator** — the Inspector tab pulses when requests are in-flight, so you know something is happening even when viewing another tab
- **Interaction persistence** — every exchange is saved as JSON to `interactions/<session>/<seq>.json` for offline analysis
- **Transparent proxy** — Claude Code sees no difference; just set `ANTHROPIC_BASE_URL` and everything flows through

### Interactive Claude Code

- **Browser-based prompting** — send prompts to Claude Code CLI from any device, no terminal needed
- **Streamed responses** — output appears in real time as Claude thinks, writes code, and uses tools
- **Persistent conversations** — session context is maintained across prompts using `--resume`, so follow-up questions work naturally. Clear History starts a fresh session
- **AskUserQuestion interception** — when Claude Code asks a question (tool selection, confirmations, clarifications), the question appears in the browser and your answer is injected back into the conversation
- **Remote project access** — configure the working directory via the settings panel (gear icon) to point Claude at any project on the machine
- **Process control** — stop a running session at any time

### Themes

Two built-in themes with a toggle in the header (persisted to localStorage):

- **dark** — Tokyo Night inspired dark theme (default)
- **hpflabs** — Bright checker-paper look with a grid background

## Getting started

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed

### Install and run

```bash
git clone https://github.com/hpfrei/claude-doc.git
cd claude-doc
npm install
```

Before starting the server, run `claude` once manually from the project directory to authenticate:

```bash
claude
```

This stores your credentials locally. The Claude tab in the dashboard spawns `claude -p` under the hood and reuses the same authentication — so this one-time setup is all that's needed.

```bash
npm start
```

You can optionally pass a dashboard port:

```bash
npm start -- 8080
```

On startup, an auth token is printed to the console. You'll need it to access the dashboard.

```
  Auth token (auto-generated):
  c0b253eb-c650-4def-ba2c-4b2b1b545d85
```

This starts two servers:

| Server    | Port | Purpose                        |
|-----------|------|--------------------------------|
| Proxy     | 3456 | API proxy for Claude Code (localhost only) |
| Dashboard | 3457 | Web interface (auth required)  |

### Use it

**Inspect API calls** — point any Claude Code session at the proxy and watch the traffic:

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
```

**Run Claude Code from the browser** — open `http://localhost:3457`, log in with the auth token, and use the Claude tab. Full conversation context, streamed output, interactive question answering — all from any device with a browser.

### Authentication

The dashboard requires a token to access. On every startup:

- If `AUTH_TOKEN` is set in the environment, that value is used
- Otherwise, a random token is auto-generated and printed to the console

The token is entered once in the browser login page and stored as an HttpOnly cookie. WebSocket connections are also authenticated.

```bash
# Use a fixed token
AUTH_TOKEN=mysecret npm start
```

### Conversation sessions

The Claude tab maintains conversation context across prompts. The session ID is captured from the first response, and subsequent prompts use `--resume` to continue the same conversation. Press **Clear History** to reset the session and start fresh.

### Project root

The Claude tab includes a settings panel (gear icon) where you can set the working directory for the spawned `claude -p` process. This lets you point Claude at any project on the machine. You can also set the default via the `PROJECT_DIR` environment variable.

### Environment variables

| Variable               | Default                      | Description                    |
|------------------------|------------------------------|--------------------------------|
| `AUTH_TOKEN`           | *(auto-generated)*           | Dashboard auth token           |
| `PROJECT_DIR`          | *(current working directory)*| Default project root for Claude|
| `PROXY_PORT`           | `3456`                       | Port for the API proxy         |
| `DASHBOARD_PORT`       | `3457`                       | Port for the web dashboard     |
| `ANTHROPIC_TARGET_URL` | `https://api.anthropic.com`  | Upstream API URL               |
| `MAX_HISTORY`          | `200`                        | Max interactions kept in memory|

## How it works

The proxy is fully transparent — it adds zero latency overhead to the SSE stream. Claude Code doesn't know it's there.

1. Claude Code sends a request to the proxy instead of directly to Anthropic
2. The proxy forwards it upstream and pipes the response back through an `SSEPassthrough` transform stream
3. Raw bytes flow to Claude Code unmodified, while parsed SSE events are tapped off and sent to the dashboard over WebSocket — no buffering, no delay
4. The dashboard renders everything in real time: each interaction appears in the timeline as it starts, tool calls are extracted from streaming content blocks as they arrive, and token counts update on completion
5. Every exchange is persisted as structured JSON for offline analysis: `interactions/<session>/<seq>.json` contains the full request, response, all SSE events, timing, and usage data

### AskUserQuestion interception

When Claude Code emits an `AskUserQuestion` tool call, the proxy intercepts the next retry request and holds it. The question is broadcast to the dashboard where you can answer from the browser. Your response is injected back into the conversation seamlessly — Claude Code never knows the answer came from a web UI instead of a terminal.

## Project structure

```
server.js              Main entry — starts proxy + dashboard servers, auth middleware
src/
  proxy.js             Express router, API forwarding, AskUserQuestion interception
  sse-passthrough.js   Transform stream that taps SSE events without buffering
  claude-session.js    Spawns and manages claude -p subprocess with session continuity
  dashboard-ws.js      WebSocket server, broadcasts events to connected dashboards
  store.js             In-memory interaction store with disk persistence
  utils.js             Header filtering, ID generation, payload sanitization
public/
  index.html           Dashboard UI (Inspector + Claude + Reference tabs)
  login.html           Auth token login page
  app.js               Client-side state management and rendering
  style.css            Layout and structural styles
  theme-dark.css       Dark theme (Tokyo Night)
  theme-hpflabs.css    Bright checker-paper theme
  tools.html           Tool schema reference page
```

## License

MIT
