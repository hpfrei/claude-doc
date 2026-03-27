# claude-doc

Inspect every Anthropic API call in real time. Run interactive Claude Code sessions from any browser.

**claude-doc** is two things in one:

1. **An Anthropic API inspector** — a transparent proxy that captures every request, response, SSE event, tool call, and token count flowing between Claude Code and the Anthropic API. See exactly what the wire protocol looks like, in real time, with full payloads you can drill into.

2. **A web-based Claude Code terminal** — send prompts from any browser, get streamed responses, answer interactive questions, and maintain full conversation context — all against a remote machine where Claude Code is running. No SSH, no terminal, just a browser.

I built this to study how Claude Code actually talks to the Anthropic API — what gets sent in each request, how the system prompt is structured, how tool calls stream back, what the token usage looks like. It evolved into my daily tool for running Claude Code on a remote PC from a phone or tablet.

## Features

### API Inspector

```
                              ┌──────────────────────────┐
                              │     claude-doc server     │
 Browser ── WebSocket ──>     │                          │
 (:3457)                      │  proxy :3456  (SSE pass) │──── HTTP/SSE ──>  Anthropic API
                              │  dashboard :3457  (WS)   │                  api.anthropic.com
                              └────────┬──────┬──────────┘
                                       │      │
                          ┌────────────┘      └────────────┐
                          │                                │
                    Built-in claude -p               External claude -p
                   (spawned, --resume)              (your terminal)
                   stream-json output
                          │
         ┌────────────────┼────────────────┐
         │                │                │
  ┌──────┴──────┐  ┌──────┴──────┐  ┌─────┴──────────────────────────┐
  │ Capability  │  │  .claude/   │  │  Integrated MCP Tool Server    │
  │ Profile     │  │  skills/    │  │  (claude-doc-tools)            │
  │             │  │  agents/    │  │                                │
  │ model       │  │  hooks      │  │  mcp-servers/integrated/       │
  │ effort      │  │  commands/  │  │    server.js (auto-generated)  │
  │ permissions │  │  settings   │  │    tools/*.js (one per tool)   │
  │ tools       │  │  .local.json│  │    meta.json (tool registry)   │
  │ budget      │  └─────────────┘  │                                │
  │             │                   │  MCP Bridge (stdio JSON-RPC)   │
  │  ──> CLI    │                   │  lib/mcp-bridge.js             │
  │     flags   │                   │  Claude Code spawns via        │
  │             │                   │  --mcp-config                  │
  └─────────────┘                   │                                │
                                    │  Auto-starts with dashboard    │
        interactions/               │  Registrar ── .mcp.json        │
        <session>/<seq>.json        │  Inspector logging via WS      │
        (full request/response)     └────────────────────────────────┘
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
- **Session management** — pick up old sessions from the dropdown, start new ones, or delete sessions you no longer need. Sessions persist across server restarts
- **Session resume** — conversation context is maintained across prompts using `--resume`, so follow-up questions work naturally
- **Profile selector** — switch between capability profiles from the toolbar. Each profile bundles model, effort level, permission mode, tool restrictions, budget, and system prompts
- **Working directory** — click the folder icon to set the project directory Claude operates in
- **AskUserQuestion interception** — when Claude Code asks a question (tool selection, confirmations, clarifications), the question appears in the browser and your answer is injected back into the conversation
- **Live task & todo panel** — `TaskCreate`, `TaskUpdate`, and `TodoWrite` tool calls are intercepted from the SSE stream and displayed as a live, draggable panel in the Claude tab. Tasks show status icons, descriptions, dependency chains, and auto-unblock. Todos preserve their original ordering. The panel collapses to a header launcher button when dismissed
- **Process control** — stop a running session at any time
- **Architecture diagram** — the welcome screen shows an interactive SVG diagram of how all the pieces connect (also available as [`public/architecture.svg`](public/architecture.svg))

### Capabilities Manager

The Capabilities tab lets you control and extend Claude Code directly from the browser:

- **Named profiles** — create, duplicate, and switch between capability profiles (Full, Safe, Read-only, Minimal built-in). Each profile bundles model, effort level, permission mode, disabled tools, max turns, budget cap, system prompt overrides, and MCP server selection — all passed as CLI flags to `claude -p`
- **Tool control** — enable/disable any of the 26 built-in tools via checkboxes per profile. Disabled tools are passed as `--disallowedTools` to the CLI
- **Custom skills** — create, edit, and delete skills stored in `.claude/skills/<name>/SKILL.md` with supporting files (templates, scripts, examples). Claude triggers them automatically based on description match, or users invoke via `/name`. Built-in skills listed for reference
- **Custom agents** — create, edit, and delete sub-agents with custom system prompts, model selection, and tool restrictions. Stored in `.claude/agents/`
- **Hook editor** — create, edit, and delete lifecycle hooks (PreToolUse, PostToolUse, Stop, etc.) with three handler types (command, prompt, agent). Stored in `.claude/settings.local.json`
- **MCP Tool Manager** — add custom tools to Claude Code via the Model Context Protocol. One integrated server, form-driven tool editor, inline testing. See the dedicated section below

### MCP Tool Manager

The MCP Tools section in Capabilities lets you extend Claude Code with custom tools through one integrated MCP server (`claude-doc-tools`):

- **One integrated server** — a single MCP server auto-starts with the dashboard and registers with Claude Code. No server management needed — just add tools
- **Form-driven tool editor** — create tools via a structured form: name, description, typed parameters (string, number, boolean, object, array), and a handler code editor. The `async (input) => {}` signature is auto-generated; you only write the handler body
- **Auto-generated server.js** — `server.js` is rebuilt automatically from enabled tools. Each tool lives in its own file under `tools/`. The server imports and registers all enabled tools
- **Enable/disable** — toggle tools on/off with checkboxes. Disabled tools are excluded from `server.js`. A "restart needed" indicator shows when tools change
- **Inline testing** — test tools directly from the edit modal with parameter inputs and result display including latency timing
- **Inspector logging** — MCP tool calls (both from dashboard tests and Claude Code usage) appear in the Inspector tab with input/output JSON detail
- **Dependencies** — shared `npm` packages for all tools. The MCP SDK and Zod are included by default

**Architecture:** The integrated server lives in `mcp-servers/integrated/`. A bridge script (`lib/mcp-bridge.js`) is what Claude Code actually spawns via `--mcp-config`. It imports the auto-generated `server.js`, connects via stdio JSON-RPC, and reports tool calls back to the dashboard for inspector logging. The dashboard must be running for Claude Code to reach your custom tools.

### Themes

Two built-in themes with a toggle in the header (persisted to localStorage):

- **bright** — bright checker-paper look with a grid background (default)
- **dark** — Tokyo Night inspired dark theme

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

| Server    | Port | Binding   | Purpose                          |
|-----------|------|-----------|----------------------------------|
| Proxy     | 3456 | localhost | API proxy for Claude Code        |
| Dashboard | 3457 | 0.0.0.0  | Web interface (auth required)    |

> **Note:** The dashboard binds to all interfaces so you can reach it from other devices. It is protected by the auth token — but do not expose it to untrusted networks without additional safeguards (TLS, VPN, firewall).

### Use it

**Run Claude Code from the browser** — open `http://localhost:3457`, log in with the auth token, and start prompting. The Claude tab is the default view.

**Inspect API calls** — point any Claude Code session at the proxy and watch the traffic in the Inspector tab:

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
```

### Authentication

The dashboard requires a token to access. On every startup:

- If `AUTH_TOKEN` is set in the environment, that value is used
- Otherwise, a random token is auto-generated and printed to the console

The token is entered once in the browser login page and stored as an HttpOnly cookie. WebSocket connections are also authenticated.

```bash
# Use a fixed token
AUTH_TOKEN=mysecret npm start
```

### Session management

The session dropdown in the header lists all sessions with their interaction count. From here you can:

- **Switch** to an old session — restores the Inspector timeline and chat history, and resumes the Claude CLI conversation
- **+ New** — starts a fresh session (also cleans up any empty sessions)
- **Del** — deletes a session and all its saved data (only for non-active sessions)

Session metadata (including the Claude CLI session ID for `--resume`) is saved alongside interaction data in `interactions/<session>/meta.json`.

### Capability profiles

The profile selector in the Claude tab toolbar (and Capabilities tab) lets you switch between named profiles. Each profile bundles:

| Setting             | CLI flag                    | Description |
|---------------------|-----------------------------|-------------|
| Model               | `--model`                   | sonnet, opus, haiku, or custom ID |
| Effort              | `--effort`                  | low, medium, high, max |
| Permission mode     | `--permission-mode`         | default, acceptEdits, plan, bypassPermissions, dontAsk, auto |
| Disabled tools      | `--disallowedTools`         | Per-tool enable/disable via checkboxes |
| Max turns           | `--max-turns`               | Cap agentic loop iterations |
| Budget              | `--max-budget-usd`          | Dollar spend limit per run |
| System prompt       | `--append-system-prompt`    | Append to default system prompt |
| System override     | `--system-prompt`           | Replace default system prompt entirely |
| Slash commands      | `--disable-slash-commands`  | Enable/disable all built-in skills |
| MCP tools           | *(auto-registered)*         | Integrated server with custom tools, always active |

Built-in profiles (Full, Safe, Read-only, Minimal) cannot be modified — duplicate them to create editable copies. Custom profiles are stored in `capabilities/profiles/`.

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
  claude-session.js    Spawns and manages claude -p subprocess with session resume
                       Builds MCP config and injects via --mcp-config
  dashboard-ws.js      WebSocket server, broadcasts events to connected dashboards
  capabilities.js      Named profiles, tool/skill/agent/hook CRUD, built-in presets
  store.js             In-memory interaction store with disk persistence and session management
  utils.js             Header filtering, ID generation, payload sanitization
  mcp/
    index.js           MCP module entrypoint — init, auto-start, WS dispatch, tool probing
    servers.js         Tool CRUD, server.js generation, file/dep management
    registrar.js       Reads/writes ~/.claude.json and .mcp.json for registration
    logs.js            JSONL log append, read, filter, stats
    templates.js       Tool template discovery and instantiation
lib/
  mcp-bridge.js        Stdio bridge Claude Code spawns — imports server.js, reports calls to dashboard
public/
  index.html           Dashboard UI (Inspector + Claude + Capabilities tabs)
  architecture.svg     Standalone architecture diagram (also embedded in index.html)
  login.html           Auth token login page
  app.js               Client-side state management and rendering
  mcp.js               MCP Tool Manager frontend module
  mcp.css              MCP-specific styles
  style.css            Layout and structural styles
  theme-bright.css     Bright checker-paper theme (default)
  theme-dark.css       Dark theme (Tokyo Night)
  tools.html           Tool schema reference page
mcp-servers/integrated/  Integrated MCP tool server (auto-generated server.js + tools/)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 hpfreilabs.com
