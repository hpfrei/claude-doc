# TODO: Multi-Claude Tabs + Workflow Engine

Implementation roadmap for two interdependent features. Each phase is self-contained and delivers standalone value.

**Design documents:**
- [`docs/MULTI_CLAUDE_TABS.md`](MULTI_CLAUDE_TABS.md) — tab-aware session architecture
- [`docs/WORKFLOW.md`](WORKFLOW.md) — workflow engine specification

**Strategic analysis:** see `.claude/plans/keen-riding-sundae.md` for competitive landscape, use cases, risk assessment, and improvement recommendations.

---

## Phase 1: Multi-Claude Tabs

Prerequisite for workflows. Also valuable standalone — context switching, parallel work, inspector filtering.

### Backend

- [ ] **`ClaudeSessionManager`** — wrap existing `ClaudeSession` in a Map-based manager
  - `sessions = new Map()` — tabId to ClaudeSession
  - Methods: `getOrCreate(tabId, cwd, caps)`, `get(tabId)`, `send(tabId, prompt)`, `kill(tabId)`, `killAll()`, `remove(tabId)`, `list()`
  - Each session unchanged internally — just adds `tabId` to all broadcasts
  - File: `src/claude-sessions.js` (new, wraps `src/claude-session.js`)
  - Reference: [`MULTI_CLAUDE_TABS.md` — Backend Changes](MULTI_CLAUDE_TABS.md#backend-changes)

- [ ] **`src/dashboard-ws.js`** — route by tabId
  - `this.claudeSession` becomes `this.sessionManager`
  - All `chat:*` handlers extract `msg.tabId` and delegate
  - On connect: send `{ type: 'chat:tabs', tabs: sessionManager.list() }`

- [ ] **`server.js`** — instantiate manager
  - Replace `new ClaudeSession(...)` with `new ClaudeSessionManager(...)`
  - Pass to `DashboardBroadcaster` and `mcp.init()`
  - Proxy's `getActiveModelDef()` — default tab or per-request routing

### Frontend

- [ ] **`public/chat.js`** — scope DOM by container
  - Replace `document.getElementById('chatMessages')` with `container.querySelector('.chat-messages')`
  - Per-tab state: `tabs = new Map()` — tabId to `{ container, currentEl, status, capabilities }`
  - `activeTabId` tracks visible tab
  - `handleMessage(msg)` routes by `msg.tabId`
  - Reference: [`MULTI_CLAUDE_TABS.md` — Frontend Changes](MULTI_CLAUDE_TABS.md#frontend-changes)

- [ ] **Tab strip UI** — above chat area
  - `[Tab 1 x] [Tab 2 x] [+]` strip
  - Replace fixed chat DOM in `public/index.html` with template + strip container
  - Each tab's content hidden/shown on switch

- [ ] **`public/core.js`** — add tabId to message routing
  - Add `tabId` to all `chat:*` message dispatch
  - Add `'view-workflows'` to views array (scaffolding for Phase 2)

### Inspector Integration

- [ ] **Tab filter** — add optional tabId filter to inspector sidebar
  - "Show only: [All | Tab 1 | Tab 2 | wf-step-fix]"
  - Add `tabId` to interaction metadata in `src/proxy.js`
  - File: `public/inspector.js`

### Migration

- [ ] Default `tab-1` auto-created on startup — zero behavior change for existing users
- [ ] `tabId` field in WS messages defaults to `tab-1` if omitted — old clients work

---

## Phase 2: Minimal Workflow Engine

Prove the concept. Sequential execution only, no parallel, no generate/compile lifecycle. Use source JSON directly with runtime interpretation.

### Backend

- [ ] **`src/workflows.js`** — CRUD + runtime engine
  - Storage: `capabilities/workflows/<name>/workflow.json`, `runs/run-<ts>.json`
  - `loadWorkflow(name)` — read source JSON
  - `saveWorkflow(name, json)` — write source JSON
  - `deleteWorkflow(name)` — remove directory
  - `listWorkflows()` — scan directory, return `[{name, description, status}]`
  - Runtime: `runWorkflow(name, inputs, sessionManager, broadcaster)`
    - Walk steps sequentially
    - Each agent step: `buildPromptFromSource(step, ctx)` → spawn `claude -p` via sessionManager
    - Condition steps: use lightweight heuristic or Haiku call to evaluate NL conditions
    - Context passing: `ctx.steps[id].output` injected into next step's prompt
    - Broadcast progress: `workflow:step:start`, `workflow:step:progress`, `workflow:step:complete`, `workflow:run:complete`
    - Save run result to `runs/`
  - Reference: [`WORKFLOW.md` — Runtime Engine](WORKFLOW.md#runtime-engine)

- [ ] **`src/workflow-handler.js`** — WS message handler
  - Follows `src/mcp/index.js` pattern: `init()`, `onConnect()`, `handleMessage()`
  - Handles: `workflow:list`, `workflow:load`, `workflow:save`, `workflow:delete`, `workflow:run`, `workflow:run:cancel`
  - Reference: [`WORKFLOW.md` — WS Message Protocol](WORKFLOW.md#ws-message-protocol)

- [ ] **Wire into existing files** (minimal changes)
  - `src/dashboard-ws.js` — add `this.workflowHandler`, delegate `workflow:*` messages (~3 lines)
  - `server.js` — init workflow handler (~2 lines)

### Frontend

- [ ] **`public/workflows.js`** — IIFE module
  - Internal state: `workflows[]`, `activeRunId`, `runStatus`, `runSteps[]`
  - Render workflow list using `.cap-list` / `.cap-list-item` pattern
  - Edit modal using `.cap-modal` pattern with JSON textarea
  - Test/Run modal: auto-generate input form from `workflow.inputs`, show live step progress
  - Step rows with status icons: `○` pending, `◌` running, `●` done, `✕` failed, `–` skipped
  - Reference: [`WORKFLOW.md` — Dashboard GUI](WORKFLOW.md#dashboard-gui--workflows-tab)

- [ ] **`public/index.html`** — add Workflows tab + view container + modals + script tag

- [ ] **`public/style.css`** — add `.wf-*` CSS classes (~40 lines)
  - `.wf-generate-bar`, `.wf-generate-input`, `.wf-step-icon.*`, `.wf-step-time`, `.wf-run-output`

- [ ] **`public/core.js`** — route `workflow:*` messages to `window.workflowModule`

### MCP Tools

- [ ] **`workflow_list()`** — list available workflows with status
- [ ] **`workflow_run(name, inputs)`** — execute a workflow, return runId
- [ ] **`workflow_status(runId)`** — current step + outputs so far
- [ ] **`workflow_cancel(runId)`** — stop a running workflow

Register in `mcp-servers/integrated/` following existing tool pattern.

### Source Format (v1 — keep it simple)

```json
{
  "name": "review-and-fix",
  "description": "Review code for issues and fix them",
  "workingDirectory": "/home/hp/myproject",
  "inputs": {
    "target": "file or directory to review",
    "focus": "what kind of issues to look for"
  },
  "steps": {
    "analyze": {
      "profile": "deep-review",
      "do": "Analyze {{target}} for {{focus}} issues",
      "produces": "list of findings with file, line, severity"
    },
    "fix": {
      "profile": "fast-coder",
      "do": "Fix the issues found",
      "context": ["analyze"],
      "next": "test"
    },
    "test": {
      "profile": "test-runner",
      "do": "Run the test suite and verify fixes",
      "condition": "all tests pass",
      "then": "done", "else": "fix",
      "maxRetries": 3
    },
    "done": { "do": "Summarize what was done" }
  }
}
```

---

## Phase 3: Generation + Compilation

UX differentiation. Add the AI-powered generate and compile lifecycle.

### Generate

- [ ] **Generate bar** in Workflows tab — user describes workflow in natural language
- [ ] **`workflow:generate`** handler — spawns `claude -p` with generation system prompt
  - Input: natural language description
  - Output: `.workflow.json` source
  - Opens edit modal with generated JSON
- [ ] **Redo** — user provides feedback, previous generation + feedback sent to new `claude -p` call

### Compile

- [ ] **Compilation** — `claude -p` transforms source JSON into deterministic `.compiled.js`
  - NL conditions become JS predicates (`evaluate(ctx)`)
  - `do` text becomes `buildPrompt(ctx)` with context injection
  - `produces` becomes `parseOutput(raw)` extractors
  - Data flow wired via `ctx.steps[id].output`
  - Reference: [`WORKFLOW.md` — Compiled Format](WORKFLOW.md#compiled-format-compiledjs)
- [ ] **Auto-compile on save** — no manual compile button, background compilation with spinner
  - `sourceHash` in compiled.js detects stale compilation
  - Show compilation errors inline
- [ ] **Update runtime** — prefer compiled.js if available, fall back to source interpretation

### Storage

```
capabilities/workflows/
  review-and-fix/
    workflow.json      ← source (user-editable)
    compiled.js        ← generated (deterministic)
    runs/
      run-1711700000000.json  ← includes compiled snapshot
```

---

## Phase 4: Advanced Features

### Parallel Execution

- [ ] **Fan-out** — `parallel: ["step-a", "step-b"]` spawns multiple sessions simultaneously
  - Each gets tabId `wf-<runId>-<stepId>`
  - Requires Phase 1 multi-tab infrastructure
- [ ] **Fan-in** — `join: "next-step"` waits for all parallel steps, collects outputs

### Error Recovery

- [ ] **Step-level timeout** — kill steps that run too long
- [ ] **Error handler steps** — "if step X fails, run step Y"
- [ ] **Resume from failure** — save workflow state to disk, offer resume on restart
- [ ] **Manual intervention** — UI affordance to answer AskUserQuestion during workflow runs

### Cost & Safety

- [ ] **Cost estimation** — show estimated cost before run (based on profiles and step count)
- [ ] **Per-step budget caps** — via profile `maxBudgetUsd`, enforced by runtime
- [ ] **Dry run mode** — show what would execute without actually spawning sessions

### Step Output UX

- [ ] **Mini-inspector per step** — reuse inspector timeline view, filtered by step's tabId
- [ ] **Step summary** — extracted from `parseOutput`, shown by default with "Show details" toggle

### Additional MCP Tools

- [ ] **`workflow_create(description)`** — generate + save a workflow via MCP (not just dashboard)
- [ ] **`workflow_run` with inline definition** — pass workflow JSON directly for one-off execution

### Implicit Workflows (stretch goal)

- [ ] Claude auto-decomposes complex prompts into workflow steps behind the scenes
- [ ] User sees it as a single conversation; dashboard shows the orchestration
- [ ] Workflows tab becomes the "advanced view" to save/edit/reuse implicit workflows
- [ ] No competitor has this — genuine differentiation

---

## Key Design Decisions

1. **Each step = full `claude -p` session** — the runtime is a session orchestrator, not an LLM orchestrator
2. **Fresh session per step** — no `--resume` between steps; different profiles per step
3. **Profile reuse** — steps reference profiles by name via `caps.loadProfile()`
4. **Stream-json parsing** — reuse pattern from `claude-session.js:202-228`
5. **Proxy routing** — steps spawn with `ANTHROPIC_BASE_URL=http://localhost:<proxyPort>` for Inspector visibility
6. **Only two step types** — `condition` (pure JS or NL-evaluated) and `agent` (full `claude -p` session)
7. **GUI reuses existing patterns** — `.cap-list`, `.cap-modal`, `.ref-tag`, `.pm-field-row`
8. **Backwards compatible** — default `tab-1` behaves identically to current singleton
9. **Auto-compile on save** (Phase 3) — no manual compile button
10. **Run snapshots** — embed compiled workflow in run JSON for versioning

---

## Files Overview

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `src/claude-sessions.js` | 1 | ClaudeSessionManager wrapping ClaudeSession |
| `src/workflows.js` | 2 | CRUD, runtime engine |
| `src/workflow-handler.js` | 2 | WS message handler |
| `public/workflows.js` | 2 | Frontend IIFE module |

### Modified Files

| File | Phase | Change |
|------|-------|--------|
| `src/dashboard-ws.js` | 1+2 | sessionManager + workflowHandler delegation |
| `server.js` | 1+2 | Init sessionManager + workflow handler |
| `public/chat.js` | 1 | Scoped DOM, tab-aware state, tab strip |
| `public/core.js` | 1+2 | tabId routing, views array, workflow message routing |
| `public/index.html` | 1+2 | Tab strip, workflows tab + view + modals + script |
| `public/inspector.js` | 1 | tabId filter on interactions |
| `public/style.css` | 2 | `.wf-*` CSS classes |
| `src/proxy.js` | 1 | Add tabId to interaction metadata |

### Reference Files (patterns to follow)

| File | Pattern |
|------|---------|
| `src/mcp/index.js` | Handler module: `init()`, `onConnect()`, `handleMessage()` |
| `src/claude-session.js:148-228` | `claude -p` spawn pattern, stream-json parsing |
| `public/capabilities.js` | CRUD list rendering, modal pattern |
| `public/mcp.js` | Dynamic modal rendering, form patterns |

---

## Competitive Context

No existing tool combines full agentic coding sessions with workflow orchestration:

| | This Project | LangGraph | n8n | Claude Code Native |
|---|---|---|---|---|
| Step depth | Full `claude -p` | LLM-in-a-loop | Single API call | Single session |
| Per-step profiles | Yes | Manual | Per-node config | No |
| Workflow definition | NL JSON | Python code | Visual drag-drop | None |
| Conditional branching | Yes | Yes | Yes | No |
| Parallel execution | Phase 4 | Yes | Yes | Sub-agents only |
| Visual UI | Dashboard | Studio (paid) | Excellent | No |
| MCP integration | Yes | No | No | N/A |

**Biggest risk**: Anthropic builds this natively. **Mitigation**: Ship Phase 1+2 fast.

**Biggest opportunity**: Implicit workflows (Phase 4) — Claude auto-decomposes complex tasks into orchestrated steps. No competitor has this.
