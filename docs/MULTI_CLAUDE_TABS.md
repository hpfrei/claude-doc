# Multi-Instance Claude Tabs

## Problem

The Claude tab is a hard singleton — one `ClaudeSession` instance, one set of DOM elements with fixed IDs, one `state.chatCurrentEl` streaming cursor. You can't run two things in parallel, can't switch contexts, and the workflow engine (which needs parallel steps) has nowhere to render step output.

## Current Architecture (What Must Change)

### Backend — `src/claude-session.js`
- **Singleton**: `server.js:75` creates one `claudeSession = new ClaudeSession(...)`. `dashboard-ws.js` holds it as `this.claudeSession`.
- **State per session**: `proc`, `buffer`, `cwd`, `sessionId`, `capabilities`, `ready`
- **Broadcast**: all events go to `this.broadcaster.broadcast()` → all WS clients, no tab identity
- **Key methods**: `send(prompt)`, `kill()`, `setCwd()`, `switchProfile()`, `newSession()`, `switchSession()`

### Frontend — `public/chat.js`
- **Hard-coded DOM IDs**: `chatMessages`, `chatInput`, `chatSendBtn`, `chatStopBtn`, `chatStatus`, `chatProfileSelect`, `chatProfileInfo`, `chatCwdLabel`
- **Shared state**: `state.chatCurrentEl` (single streaming cursor), `state.capabilities`, `state.activeProfileName`
- **No tab identity**: `handleMessage()` processes all `chat:*` messages without filtering

### Frontend — `public/index.html`
- **Single view**: `#view-claude` with all chat DOM inside it
- **Session picker**: global in header, shared across views

## Design: Tab-Aware Sessions

### Concept: `tabId`

Every chat interaction gets a `tabId` — a short unique identifier (e.g., `tab-1`, `tab-2`, `wf-run-abc-step-fix`). The tabId travels through every message:

- Client → server: `{ type: 'chat:send', tabId: 'tab-1', prompt: '...' }`
- Server → client: `{ type: 'chat:event', tabId: 'tab-1', event: {...} }`

### Backend Changes

#### `src/claude-session.js` → `src/claude-sessions.js` (session manager)

Replace the singleton with a Map-based manager:

```javascript
class ClaudeSessionManager {
  constructor(proxyPort, store, opts) { ... }
  sessions = new Map()  // tabId → ClaudeSession

  getOrCreate(tabId, cwd, capabilities)  // lazy-creates a session
  get(tabId)                             // returns existing or null
  send(tabId, prompt)                    // delegates to session.send()
  kill(tabId)                            // kills one session
  killAll()                              // kills all
  remove(tabId)                          // kills + removes from map
  list()                                 // returns [{tabId, status, cwd, profile}]
}
```

Each `ClaudeSession` instance is unchanged internally — it still has its own `proc`, `buffer`, `sessionId`, `capabilities`. The difference is that `broadcast()` calls now include the `tabId`:

```javascript
this.broadcaster.broadcast({ type: 'chat:event', tabId: this.tabId, event });
this.broadcaster.broadcast({ type: 'chat:status', tabId: this.tabId, status: 'running' });
```

#### `src/dashboard-ws.js`

- `this.claudeSession` → `this.sessionManager` (a `ClaudeSessionManager`)
- All `chat:*` message handlers extract `msg.tabId` and route to the correct session:

```javascript
if (msg.type === 'chat:send') {
  this.sessionManager.send(msg.tabId, msg.prompt);
} else if (msg.type === 'chat:stop') {
  this.sessionManager.kill(msg.tabId);
}
```

- On connect, send list of active tabs: `{ type: 'chat:tabs', tabs: sessionManager.list() }`

#### `server.js`

- `claudeSession = new ClaudeSession(...)` → `sessionManager = new ClaudeSessionManager(...)`
- Pass `sessionManager` to `DashboardBroadcaster` and `mcp.init()`
- Proxy's `getActiveModelDef()` needs a default tab or per-request routing

### Frontend Changes

#### `public/chat.js` → Tab-Aware Module

The module manages multiple tab instances. Each tab instance has its own:

- DOM container (cloned from a template, not fixed IDs)
- Streaming cursor (`currentEl`)
- Status, capabilities, profile
- Message history

```javascript
tabs = new Map()  // tabId → { container, currentEl, status, capabilities, ... }
activeTabId = 'tab-1'  // which tab is currently visible
```

**DOM strategy**: Instead of fixed IDs, each tab's elements are scoped under a container div. Use `container.querySelector('.chat-messages')` instead of `document.getElementById('chatMessages')`.

**Tab bar**: A row of tab buttons above the chat area:

```
[Tab 1 ×] [Tab 2 ×] [+]           ← tab strip
[chat messages area]                ← shows active tab's content
[input area]                        ← shared or per-tab
```

**Message routing**: `handleMessage(msg)` checks `msg.tabId` and routes to the correct tab instance. If `msg.tabId` doesn't match any tab, create one (for workflow-spawned tabs).

#### `public/core.js`

- Add `tabId` to all `chat:*` message dispatch
- Session picker may become per-tab or remain global (TBD)

#### `public/index.html`

- Replace fixed chat DOM with a template + tab strip container
- Or: keep the first tab as-is for backwards compat, add new tabs dynamically

### Inspector Integration

- Inspector already works per store-session (not per Claude session)
- Workflow steps could use a shared store-session OR each get their own
- Add optional `tabId` filter to inspector sidebar: "Show only: [All | Tab 1 | Tab 2 | wf-step-fix]"
- Interactions already have metadata — add `tabId` to interaction data so inspector can filter

### Migration Path (Backwards Compatible)

1. Default tab `tab-1` is auto-created on startup — behaves exactly like the current singleton
2. Users who never click "+" see zero difference
3. The `tabId` field in WS messages defaults to `tab-1` if omitted — old clients still work
4. Workflow engine creates tabs programmatically with `tabId: 'wf-<runId>-<stepId>'`

## Files to Modify

| File | Change |
|------|--------|
| `src/claude-session.js` | Refactor: extract session manager, add tabId to broadcasts |
| `src/dashboard-ws.js` | Route chat messages by tabId |
| `server.js` | Instantiate session manager instead of single session |
| `public/chat.js` | Tab-aware: multiple instances, scoped DOM, tab strip |
| `public/core.js` | Route chat messages by tabId |
| `public/index.html` | Tab strip, template-based chat DOM |
| `public/inspector.js` | Optional tabId filter on interactions |

## Implementation Order

1. Backend: `ClaudeSessionManager` wrapping existing `ClaudeSession` (add tabId to broadcasts, Map-based routing)
2. Frontend: refactor chat.js to scope DOM by container instead of global IDs
3. Frontend: add tab strip with "+" button
4. Wire tabId through all WS messages
5. Inspector: add tabId to interactions, add filter dropdown
