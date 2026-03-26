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
  │ Capability  │  │  .claude/   │  │     MCP Server Manager         │
  │ Profile     │  │  skills/    │  │                                │
  │             │  │  agents/    │  │  mcp-servers/<slug>/           │
  │ model       │  │  hooks      │  │    meta.json, server.js        │
  │ effort      │  │  commands/  │  │                                │
  │ permissions │  │  settings   │  │  Worker Host ── IPC ── Workers │
  │ tools       │  │  .local.json│  │  (fork, hot-reload, approval)  │
  │ budget      │  └─────────────┘  │                                │
  │ mcpServers[]│                   │  MCP Bridge (stdio JSON-RPC)   │
  │  ──> CLI    │                   │  lib/mcp-bridge.js             │
  │     flags   │                   │  Claude Code spawns via        │
  │  ──> --mcp- │ ── writes ──>    │  --mcp-config temp file        │
  │     config  │  /tmp/config.json │                                │
  └─────────────┘                   │  Registrar ── ~/.claude.json   │
                                    │  Logs ── JSONL daily files     │
        interactions/               │  Templates ── blank, REST,     │
        <session>/<seq>.json        │    JSON store, file tools      │
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
- **Architecture diagram** — the welcome screen shows an interactive SVG diagram of how all the pieces connect

### Capabilities Manager

The Capabilities tab lets you control and extend Claude Code directly from the browser:

- **Named profiles** — create, duplicate, and switch between capability profiles (Full, Safe, Read-only, Minimal built-in). Each profile bundles model, effort level, permission mode, disabled tools, max turns, budget cap, system prompt overrides, and MCP server selection — all passed as CLI flags to `claude -p`
- **Tool control** — enable/disable any of the 26 built-in tools via checkboxes per profile. Disabled tools are passed as `--disallowedTools` to the CLI
- **Custom skills** — create, edit, and delete skills stored in `.claude/skills/<name>/SKILL.md` with supporting files (templates, scripts, examples). Claude triggers them automatically based on description match, or users invoke via `/name`. Built-in skills listed for reference
- **Custom agents** — create, edit, and delete sub-agents with custom system prompts, model selection, and tool restrictions. Stored in `.claude/agents/`
- **Hook editor** — create, edit, and delete lifecycle hooks (PreToolUse, PostToolUse, Stop, etc.) with three handler types (command, prompt, agent). Stored in `.claude/settings.local.json`
- **MCP Server Manager** — create, edit, test, and manage custom MCP (Model Context Protocol) tool servers directly from the browser. See the dedicated section below

### MCP Server Manager

The MCP Servers tab in Capabilities lets you build custom tool servers that extend Claude Code's capabilities through the Model Context Protocol:

- **Server CRUD** — create servers from starter templates (blank, REST API wrapper, JSON data store, file tools), edit code in a browser-based editor, manage dependencies, and delete servers. Each server lives in its own `mcp-servers/<slug>/` directory with isolated `node_modules/`
- **Template picker** — choose from four starter templates when creating a new server. Templates include pre-built tool definitions using the MCP SDK and Zod schemas
- **Code editor** — edit `server.js` and supporting files directly in the browser. File tree navigation, output panel for server stdout/stderr, and SDK quick reference sidebar
- **Dependency management** — install/uninstall npm packages per server. The MCP SDK and Zod are provided by the host app (bundled, no install needed)
- **Testing console** — select a tool from the running server, fill in parameters via a dynamically generated form (based on the tool's Zod schema), execute, and see the result with latency timing
- **Logs** — all tool calls (from Claude Code and test invocations) are logged as daily JSONL files with filtering, search, and stats (total calls, error rate, average latency)
- **Profile integration** — each capability profile has an `mcpServers[]` field. Select which MCP servers to enable per profile. Selected servers are written to a temp config file and passed to `claude -p` via `--mcp-config`

**Architecture:** Your server code runs in an isolated child process (forked by the Worker Host). A lightweight bridge script (`lib/mcp-bridge.js`) relays JSON-RPC messages between Claude Code and the server through the dashboard's WebSocket connection. The dashboard must be running for Claude Code to reach your custom tools.

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
| MCP servers         | `--mcp-config`              | Select which custom MCP tool servers to enable |

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
    index.js           MCP module entrypoint — init, WS dispatch, shutdown
    servers.js         Server CRUD, file operations, dependency management
    registrar.js       Reads/writes ~/.claude.json and .mcp.json for server registration
    logs.js            JSONL log append, read, filter, stats, rotation
    templates.js       Template discovery and instantiation
    worker-host.js     Fork/manage worker processes, IPC relay, approval gate (Phase 2)
    worker-entry.js    Bootstrap script for forked worker processes (Phase 2)
lib/
  mcp-bridge.js        Standalone stdio bridge Claude Code spawns via --mcp-config (Phase 2)
templates/mcp-servers/
  blank/               Empty server with hello tool
  rest-api-wrapper/    HTTP GET/POST with configurable BASE_URL
  json-data-store/     Key-value store backed by JSON file
  file-tools/          Read, write, list, search files with ROOT_DIR
public/
  index.html           Dashboard UI (Inspector + Claude + Capabilities tabs)
  login.html           Auth token login page
  app.js               Client-side state management and rendering
  mcp.js               MCP Server Manager frontend module
  mcp.css              MCP-specific styles
  style.css            Layout and structural styles
  theme-bright.css     Bright checker-paper theme (default)
  theme-dark.css       Dark theme (Tokyo Night)
  tools.html           Tool schema reference page
mcp-servers/           Runtime storage for user-created MCP servers
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

MIT — see [LICENSE](LICENSE).
