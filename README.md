# claude-doc

A transparent API proxy and web dashboard for studying Claude Code CLI interactions with the Anthropic API.

I built this to understand exactly what happens in the wire protocol between Claude Code and the Anthropic API — every request, every SSE event, every tool call. It started as a simple logging proxy and evolved into a full web interface for running Claude Code CLI sessions on a remote machine from a browser.

## What it does

**claude-doc** sits between Claude Code and the Anthropic API, captures every exchange, and presents it in a real-time web dashboard.

```
Browser  --->  Dashboard (:3457)  <--- WebSocket --->  Proxy (:3456)  --->  Anthropic API
                                                          ^
                                                          |
                                                    Claude Code CLI
```

### Proxy (port 3456)

- Forwards all `/v1/messages` and `/v1/messages/count_tokens` requests to the Anthropic API
- Passes through SSE streaming transparently — Claude Code sees no difference
- Records every request/response pair with timing, token usage, and full SSE event streams
- Intercepts `AskUserQuestion` tool calls so they can be answered from the dashboard

### Dashboard (port 3457)

- **Inspector** — Timeline of every API call. Select any interaction to see the full request payload, response, individual SSE events, and extracted tool calls
- **Claude** — Run Claude Code CLI sessions directly from the browser. Send prompts, see streamed output, stop running sessions. This is how I use it to operate Claude Code on a remote PC from any device
- **Reference** — Built-in reference for Claude Code's tool schemas

## Getting started

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Install and run

```bash
git clone https://github.com/hpfrei/claude-doc.git
cd claude-doc
npm install
npm start
```

This starts two servers:

| Server    | Port | Purpose                        |
|-----------|------|--------------------------------|
| Proxy     | 3456 | API proxy for Claude Code      |
| Dashboard | 3457 | Web interface                  |

### Point Claude Code at the proxy

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
```

Or open `http://localhost:3457` and use the Claude tab to send prompts directly from the browser.

### Environment variables

| Variable               | Default                      | Description                    |
|------------------------|------------------------------|--------------------------------|
| `PROXY_PORT`           | `3456`                       | Port for the API proxy         |
| `DASHBOARD_PORT`       | `3457`                       | Port for the web dashboard     |
| `ANTHROPIC_TARGET_URL` | `https://api.anthropic.com`  | Upstream API URL               |
| `MAX_HISTORY`          | `200`                        | Max interactions kept in memory|

## How it works

1. Claude Code sends a request to the proxy instead of directly to Anthropic
2. The proxy forwards the request upstream and streams the response back
3. An `SSEPassthrough` transform stream taps into the response without buffering — raw bytes flow to Claude Code while parsed events are sent to the dashboard over WebSocket
4. Each interaction (request + response + all SSE events + timing) is saved to `interactions/<session>/<seq>.json`
5. The dashboard renders everything in real time: tool calls are extracted from streaming content blocks, token usage is tracked, and timing data is displayed

### AskUserQuestion interception

When Claude Code emits an `AskUserQuestion` tool call, the proxy holds the next request and broadcasts the question to the dashboard. You answer from the browser, and the proxy injects your response back into the conversation — enabling fully remote interactive sessions.

## Project structure

```
server.js              Main entry — starts proxy + dashboard servers
src/
  proxy.js             Express router, API forwarding, AskUserQuestion interception
  sse-passthrough.js   Transform stream that taps SSE events without buffering
  claude-session.js    Spawns and manages claude -p subprocess
  dashboard-ws.js      WebSocket server, broadcasts events to connected dashboards
  store.js             In-memory interaction store with disk persistence
  utils.js             Header filtering, ID generation, payload sanitization
public/
  index.html           Dashboard UI (Inspector + Claude + Reference tabs)
  app.js               Client-side state management and rendering
  style.css            Dashboard styles
  tools.html           Tool schema reference page
```

## License

MIT
