// === MCP Server Manager — self-contained frontend module ===
(function() {
  'use strict';
  const { state, sendWs, escHtml } = window.dashboard;

  // --- MCP-local state ---
  const mcp = {
    servers: [],
    templates: [],
    editing: null,       // slug of server open in modal
    editMeta: null,      // working copy of meta for Setup tab
    activeTab: 'setup',
    files: [],
    activeFile: null,
    unsaved: false,
    output: [],          // server output lines
    testHistory: [],
    testResult: null,
    tools: [],           // tools from running server
    deps: [],
    depOutput: '',
    logs: { entries: [], total: 0 },
    logStats: null,
    expanded: {},        // slug → true/false for expanded server rows
  };

  // --- WS Message Dispatch ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'mcp:list':
        mcp.servers = msg.servers || [];
        renderPanel();
        break;
      case 'mcp:templates':
        mcp.templates = msg.templates || [];
        break;
      case 'mcp:created':
        openModal(msg.server.slug, msg.server);
        break;
      case 'mcp:loaded':
        mcp.editMeta = msg.server;
        if (mcp.editing) renderActiveTab();
        break;
      case 'mcp:updated':
        mcp.editMeta = msg.server;
        mcp.unsaved = false;
        renderActionBar();
        break;
      case 'mcp:error':
        alert(msg.error);
        break;
      case 'mcp:file:list':
        if (msg.slug === mcp.editing) { mcp.files = msg.files || []; renderFileList(); }
        break;
      case 'mcp:file:content':
        if (msg.slug === mcp.editing) { mcp.activeFile = msg.path; setEditorContent(msg.content); }
        break;
      case 'mcp:file:written':
        mcp.unsaved = false;
        renderActionBar();
        break;
      case 'mcp:status':
        updateServerStatus(msg.slug, msg.status, msg.error);
        break;
      case 'mcp:tools':
        if (msg.slug === mcp.editing) { mcp.tools = msg.tools || []; if (mcp.activeTab === 'testing') renderTestingTab(); }
        break;
      case 'mcp:output':
        if (msg.slug === mcp.editing) appendOutput(msg.data, msg.stream);
        break;
      case 'mcp:log':
        if (msg.slug === mcp.editing && mcp.activeTab === 'logs') {
          mcp.logs.entries.unshift(msg.entry);
          renderLogEntries();
        }
        break;
      case 'mcp:test:result':
        mcp.testResult = msg;
        mcp.testHistory.unshift({ timestamp: new Date().toISOString(), tool: msg.tool, status: msg.error ? 'error' : 'success', latencyMs: msg.latencyMs, request: msg.request, response: msg.result });
        if (mcp.activeTab === 'testing') renderTestResult();
        break;
      case 'mcp:deps:list':
        if (msg.slug === mcp.editing) { mcp.deps = msg.deps || []; if (mcp.activeTab === 'deps') renderDepsTable(); }
        break;
      case 'mcp:dep-progress':
        if (msg.slug === mcp.editing) { mcp.depOutput += msg.output; if (mcp.activeTab === 'deps') renderDepOutput(); }
        break;
      case 'mcp:logs:result':
        if (msg.slug === mcp.editing) { mcp.logs = { entries: msg.entries || [], total: msg.total || 0 }; if (mcp.activeTab === 'logs') renderLogEntries(); }
        break;
      case 'mcp:logs:stats':
        if (msg.slug === mcp.editing) { mcp.logStats = msg.stats; if (mcp.activeTab === 'logs') renderLogStats(); }
        break;
    }
  }

  function updateServerStatus(slug, status, error) {
    const s = mcp.servers.find(s => s.slug === slug);
    if (s) { s.status = status; if (error) s.error = error; }
    renderPanel();
    if (mcp.editing === slug) renderActionBar();
  }

  // ========== PANEL RENDERING ==========

  function renderPanel() {
    const panel = document.getElementById('ref-mcp');
    if (!panel) return;

    // Update stats counter
    const countEl = document.getElementById('capMcpCount');
    if (countEl) {
      const running = mcp.servers.filter(s => s.status === 'running').length;
      countEl.textContent = running > 0 ? `${running} running` : mcp.servers.length.toString();
    }

    if (mcp.servers.length === 0) {
      panel.innerHTML = renderIntro() + renderSectionHeader() +
        `<div class="mcp-empty">No MCP servers yet.<br>Click <strong>+ New Server</strong> to create your first custom tool server,<br>or pick from a starter template.</div>`;
      attachPanelEvents(panel);
      return;
    }

    let html = renderIntro() + renderSectionHeader() + '<div class="cap-list" id="mcpServerList">';
    for (const s of mcp.servers) {
      const expanded = mcp.expanded[s.slug];
      html += `<div class="cap-list-item mcp-server-row${expanded ? ' expanded' : ''}" data-slug="${s.slug}">
        <span class="cap-item-name"><span class="mcp-status ${s.status || 'stopped'}" title="${statusTitle(s)}"></span><span class="mcp-server-icon">${s.icon || '🔧'}</span>${escHtml(s.name)}</span>
        <span class="cap-item-desc">${escHtml(s.description || '')}</span>
        <span class="mcp-tool-count">${s.toolCount || 0} tools</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn mcp-btn-settings" data-slug="${s.slug}" title="Open settings">&#9881;</button>
          <button class="cap-edit-btn mcp-btn-edit" data-slug="${s.slug}" title="Edit code">&#9998;</button>
          <button class="cap-del-btn mcp-btn-delete" data-slug="${s.slug}" title="Delete server">&#10005;</button>
        </span>
        <div class="mcp-tool-list">${renderToolList(s)}</div>
      </div>`;
    }
    html += '</div>';
    panel.innerHTML = html;
    attachPanelEvents(panel);
  }

  function renderIntro() {
    return `<div class="ref-intro">
      <strong>MCP Servers</strong> are custom tool servers that extend Claude Code's capabilities through the
      Model Context Protocol. Each server you create here registers with Claude Code as an MCP endpoint &mdash;
      Claude can discover and call your tools just like built-in ones (Read, Write, Bash, etc.).
      <br><br>
      <strong>Architecture:</strong> your server code runs in an isolated child process. A lightweight bridge script
      relays JSON-RPC messages between Claude Code and the server through this dashboard. The dashboard must be running
      for Claude Code to reach your custom tools.
      <br><br>
      <strong>Lifecycle:</strong> Create a server &rarr; write tool handlers in <code>server.js</code> &rarr; Start it &rarr;
      Claude Code can now call your tools. Edits trigger hot-reload. Stopping a server unregisters it from Claude Code.
      Servers are stored in <code>mcp-servers/</code> inside this application's directory. Each server has its own
      <code>package.json</code> and <code>node_modules</code> for dependency isolation.
    </div>`;
  }

  function renderSectionHeader() {
    return `<div class="cap-section-header">
      <span>Managed servers stored in <code>mcp-servers/</code></span>
      <button class="cap-new-btn" id="mcpNewServer">+ New Server</button>
    </div>`;
  }

  function renderToolList(server) {
    if (server.status !== 'running' || !server.tools?.length) {
      return '<div class="mcp-tool-hint">Start the server to see registered tools.</div>';
    }
    return server.tools.map(t => `<div class="mcp-tool-item"><span class="mcp-tool-name">${escHtml(t.name)}</span><span>${escHtml(t.description || '')}</span></div>`).join('');
  }

  function statusTitle(s) {
    if (s.status === 'running') return 'Running' + (s.uptime ? ` — uptime ${s.uptime}` : '');
    if (s.status === 'error') return 'Error: ' + (s.error || 'Unknown error');
    if (s.status === 'restarting') return 'Restarting...';
    return 'Stopped';
  }

  function attachPanelEvents(panel) {
    // New server button
    panel.querySelector('#mcpNewServer')?.addEventListener('click', showTemplatePicker);
    // Server row clicks
    panel.querySelectorAll('.mcp-server-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.cap-list-actions')) return;
        const slug = row.dataset.slug;
        mcp.expanded[slug] = !mcp.expanded[slug];
        row.classList.toggle('expanded');
      });
    });
    // Action buttons
    panel.querySelectorAll('.mcp-btn-settings').forEach(btn => btn.addEventListener('click', () => { openModal(btn.dataset.slug); switchTab('setup'); }));
    panel.querySelectorAll('.mcp-btn-edit').forEach(btn => btn.addEventListener('click', () => { openModal(btn.dataset.slug); switchTab('code'); }));
    panel.querySelectorAll('.mcp-btn-delete').forEach(btn => btn.addEventListener('click', () => {
      if (confirm(`Delete server "${btn.dataset.slug}"? This removes all files and cannot be undone.`)) {
        sendWs({ type: 'mcp:delete', slug: btn.dataset.slug });
      }
    }));
  }

  // ========== TEMPLATE PICKER ==========

  function showTemplatePicker() {
    let html = `<div class="mcp-tpl-backdrop" id="mcpTplPicker">
      <div class="mcp-tpl-dialog">
        <div class="mcp-tpl-header"><h3>Pick a template</h3><button class="cap-modal-close mcp-tpl-close" title="Close">&times;</button></div>
        <div class="mcp-tpl-hint">Start with a template or create a blank server. You can modify everything after creation.</div>
        <div class="mcp-tpl-grid">`;
    for (const t of mcp.templates) {
      html += `<div class="mcp-tpl-card" data-template="${t.id}">
        <div class="mcp-tpl-card-icon">${t.icon || '🔧'}</div>
        <div class="mcp-tpl-card-name">${escHtml(t.name)}</div>
        <div class="mcp-tpl-card-desc">${escHtml(t.description)}</div>
        <div class="mcp-tpl-card-deps">Deps: ${t.extraDeps?.length ? t.extraDeps.join(', ') : 'none'}</div>
      </div>`;
    }
    html += '</div></div></div>';
    const root = document.getElementById('mcp-modal-root');
    root.innerHTML = html;
    // Events
    root.querySelector('.mcp-tpl-close')?.addEventListener('click', hideTemplatePicker);
    root.querySelector('.mcp-tpl-backdrop')?.addEventListener('click', (e) => { if (e.target.classList.contains('mcp-tpl-backdrop')) hideTemplatePicker(); });
    root.querySelectorAll('.mcp-tpl-card').forEach(card => card.addEventListener('click', () => {
      const tpl = card.dataset.template;
      const base = mcp.templates.find(t => t.id === tpl)?.name?.toLowerCase().replace(/\s+/g, '-') || 'my-server';
      // Auto-generate unique name (append -2, -3... if taken)
      let name = base;
      const existing = new Set(mcp.servers.map(s => s.slug));
      let i = 2;
      while (existing.has(name)) { name = `${base}-${i++}`; }
      hideTemplatePicker();
      sendWs({ type: 'mcp:create', name, template: tpl });
    }));
  }

  function hideTemplatePicker() {
    document.getElementById('mcp-modal-root').innerHTML = '';
  }

  // ========== SERVER MODAL ==========

  function openModal(slug, meta) {
    mcp.editing = slug;
    mcp.editMeta = meta || null;
    mcp.activeTab = mcp.activeTab || 'setup';
    mcp.output = [];
    mcp.testHistory = [];
    mcp.testResult = null;
    mcp.tools = [];
    mcp.deps = [];
    mcp.depOutput = '';
    mcp.files = [];
    mcp.activeFile = null;
    mcp.unsaved = !!meta;  // new servers need save before start
    mcp.logs = { entries: [], total: 0 };
    mcp.logStats = null;

    // Load server data
    sendWs({ type: 'mcp:load', slug });
    sendWs({ type: 'mcp:file:list', slug });
    sendWs({ type: 'mcp:deps:list', slug });
    sendWs({ type: 'mcp:logs', slug, opts: { limit: 50 } });
    sendWs({ type: 'mcp:logs:stats', slug });
    // Request tools if server is running
    const srv = mcp.servers.find(s => s.slug === slug);
    if (srv?.status === 'running') sendWs({ type: 'mcp:tools', slug });

    renderModal();
  }

  function closeModal() {
    if (mcp.unsaved && !confirm('You have unsaved changes. Close anyway?')) return;
    mcp.editing = null;
    mcp.editMeta = null;
    document.getElementById('mcp-modal-root').innerHTML = '';
  }

  function renderModal() {
    const meta = mcp.editMeta || mcp.servers.find(s => s.slug === mcp.editing) || {};

    let html = `<div class="mcp-modal-backdrop" id="mcpModalBackdrop">
      <div class="mcp-modal">
        <div class="mcp-action-bar" id="mcpActionBar"></div>
        <div class="mcp-tabs" id="mcpTabs">
          ${['setup','code','testing','logs','deps'].map(t =>
            `<button class="mcp-tab${mcp.activeTab === t ? ' active' : ''}" data-tab="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
          ).join('')}
        </div>
        <div class="mcp-tab-content${mcp.activeTab === 'setup' ? ' active' : ''}" id="mcpTabSetup"></div>
        <div class="mcp-tab-content${mcp.activeTab === 'code' ? ' active' : ''}" id="mcpTabCode"></div>
        <div class="mcp-tab-content${mcp.activeTab === 'testing' ? ' active' : ''}" id="mcpTabTesting"></div>
        <div class="mcp-tab-content${mcp.activeTab === 'logs' ? ' active' : ''}" id="mcpTabLogs"></div>
        <div class="mcp-tab-content${mcp.activeTab === 'deps' ? ' active' : ''}" id="mcpTabDeps"></div>
      </div>
    </div>`;

    document.getElementById('mcp-modal-root').innerHTML = html;

    // Tab switching
    document.getElementById('mcpTabs')?.addEventListener('click', (e) => {
      const tab = e.target.dataset?.tab;
      if (tab) switchTab(tab);
    });

    // Backdrop close
    document.getElementById('mcpModalBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'mcpModalBackdrop') closeModal();
    });

    // Keyboard
    document.addEventListener('keydown', modalKeyHandler);

    renderActionBar();
    renderActiveTab();
  }

  function modalKeyHandler(e) {
    if (!mcp.editing) { document.removeEventListener('keydown', modalKeyHandler); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
    if (e.key === 'Escape') closeModal();
  }

  function renderActionBar() {
    const bar = document.getElementById('mcpActionBar');
    if (!bar) return;
    const meta = mcp.editMeta || {};
    const s = mcp.servers.find(s => s.slug === mcp.editing) || {};
    const status = s.status || 'stopped';
    const running = status === 'running';
    const stopped = status === 'stopped';

    bar.innerHTML = `
      <label class="mcp-action-label">Name: <input type="text" id="mcpModalName" value="${escHtml(meta.name || mcp.editing || '')}" title="Display name — also determines the slug (directory name)"></label>
      <span class="mcp-action-status"><span class="mcp-status ${status}"></span>${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      <div class="mcp-action-btns">
        <button class="mcp-action-btn" id="mcpBtnStart" ${running || mcp.unsaved ? 'disabled' : ''} title="${mcp.unsaved ? 'Save changes before starting' : 'Start the server and register with Claude Code'}">&#9654; Start</button>
        <button class="mcp-action-btn" id="mcpBtnRestart" ${stopped ? 'disabled' : ''} title="Restart with current code — Claude Code connection preserved">&#8635; Restart</button>
        <button class="mcp-action-btn" id="mcpBtnStop" ${stopped ? 'disabled' : ''} title="Stop the server and unregister from Claude Code">&#9724; Stop</button>
        <button class="mcp-action-btn primary" id="mcpBtnSave" title="Save all changes (Ctrl+S). If running, triggers hot-reload.">Save</button>
        <button class="mcp-action-btn close-btn" id="mcpBtnClose" title="Close">&times;</button>
      </div>`;

    bar.querySelector('#mcpBtnStart')?.addEventListener('click', () => sendWs({ type: 'mcp:start', slug: mcp.editing }));
    bar.querySelector('#mcpBtnRestart')?.addEventListener('click', () => sendWs({ type: 'mcp:restart', slug: mcp.editing }));
    bar.querySelector('#mcpBtnStop')?.addEventListener('click', () => sendWs({ type: 'mcp:stop', slug: mcp.editing }));
    bar.querySelector('#mcpBtnSave')?.addEventListener('click', saveAll);
    bar.querySelector('#mcpBtnClose')?.addEventListener('click', closeModal);
    bar.querySelector('#mcpModalName')?.addEventListener('input', (e) => {
      if (mcp.editMeta) mcp.editMeta.name = e.target.value;
      // Sync to setup tab name field if visible
      const setupName = document.getElementById('mcpSetupName');
      if (setupName) setupName.value = e.target.value;
      mcp.unsaved = true;
      renderActionBar();
    });
  }

  function switchTab(tab) {
    mcp.activeTab = tab;
    document.querySelectorAll('.mcp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.mcp-tab-content').forEach(c => c.classList.remove('active'));
    const el = document.getElementById('mcpTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (el) { el.classList.add('active'); }
    renderActiveTab();
  }

  function renderActiveTab() {
    switch (mcp.activeTab) {
      case 'setup': renderSetupTab(); break;
      case 'code': renderCodeTab(); break;
      case 'testing': renderTestingTab(); break;
      case 'logs': renderLogsTab(); break;
      case 'deps': renderDepsTab(); break;
    }
  }

  // ========== SETUP TAB ==========

  function renderSetupTab() {
    const el = document.getElementById('mcpTabSetup');
    if (!el) return;
    const meta = mcp.editMeta || {};

    el.innerHTML = `<div class="mcp-columns">
      <div class="mcp-main">

        <div class="mcp-form-group">
          <h4>Server Identity</h4>
          <div class="mcp-form-row"><label>Name: <input type="text" id="mcpSetupName" value="${escHtml(meta.name || '')}" placeholder="e.g. my-api-tools"></label></div>
          <div class="mcp-slug">Slug: <code>${escHtml(meta.slug || mcp.editing || '')}</code> (directory name, used as Claude Code ID)</div>
          <div class="mcp-form-row"><label style="flex:1">Description: <input type="text" id="mcpSetupDesc" value="${escHtml(meta.description || '')}" placeholder="e.g. Tools for interacting with the internal REST API"></label></div>
          <div class="mcp-form-hint">Shown to Claude to help it decide when to use these tools.</div>
          <div class="mcp-form-row"><label>Icon: <input type="text" id="mcpSetupIcon" value="${meta.icon || '🔧'}" style="width:40px;text-align:center"></label><span class="mcp-form-hint" style="margin:0">Emoji shown in the server list.</span></div>
        </div>

        <div class="mcp-form-group">
          <h4>Connection</h4>
          <div class="mcp-form-row">
            <label>Scope: <select id="mcpSetupScope"><option value="user"${meta.scope === 'user' ? ' selected' : ''}>user</option><option value="project"${meta.scope === 'project' ? ' selected' : ''}>project</option></select></label>
            <span class="mcp-form-hint" style="margin:0">Where to register in Claude Code config.</span>
          </div>
          <div class="mcp-form-row"><label><input type="checkbox" id="mcpSetupAutoReg" ${meta.autoRegister !== false ? 'checked' : ''}> Auto-register</label><span class="mcp-form-hint" style="margin:0">Automatically add/remove from Claude Code config when server starts/stops.</span></div>
          <div class="mcp-form-row"><label><input type="checkbox" id="mcpSetupAutoStart" ${meta.autoStart ? 'checked' : ''}> Auto-start</label><span class="mcp-form-hint" style="margin:0">Start this server when the dashboard launches.</span></div>
        </div>

        <div class="mcp-form-group">
          <h4>Environment Variables</h4>
          <div class="mcp-form-hint">Injected into the server process and passed to Claude Code's MCP config. Use for API keys, base URLs, and configuration.</div>
          <table class="mcp-env-table" id="mcpEnvTable">
            <tr><th>Name</th><th>Value</th><th>Secret</th><th></th></tr>
            ${renderEnvRows(meta.env || {}, meta.secrets || {})}
          </table>
          <button class="cap-new-btn" id="mcpAddEnv" style="font-size:11px">+ Add Variable</button>
          <div class="mcp-form-hint">Secret values are masked and stored separately.</div>
        </div>

        <div class="mcp-form-group">
          <h4>Approval Gates</h4>
          <div class="mcp-form-hint">Tools listed here require your approval before executing. When Claude calls a gated tool, a dialog appears in the dashboard.</div>
          <div class="mcp-form-row"><input type="text" id="mcpSetupApproval" value="${escHtml((meta.approvalRequired || []).join(', '))}" placeholder="e.g. deploy_staging, delete_record" style="flex:1"></div>
          <div class="mcp-form-hint">Comma-separated tool names. Leave empty to approve all automatically.</div>
        </div>

      </div>
      <div class="mcp-docs">
        <h4>Scope Options</h4>
        <pre class="mcp-docs-pre">user      Registers in ~/.claude.json
          Available across all projects.

project   Registers in .mcp.json in the
          current project root. Shared
          via version control.</pre>
        <h4>Environment Variables</h4>
        <p class="mcp-docs-hint">Variables are injected as <code>process.env</code> in your server code and passed in the MCP config's "env" block.</p>
        <pre class="mcp-docs-pre">// Access in server.js:
const url = process.env.BASE_URL;
const key = process.env.API_KEY;</pre>
        <h4>How Registration Works</h4>
        <p class="mcp-docs-hint">When you start a server, this entry is written to your Claude Code config:</p>
        <pre class="mcp-docs-pre">"mcpServers": {
  "my-server": {
    "command": "node",
    "args": ["mcp-bridge.js", "slug"],
    "env": { ... }
  }
}</pre>
        <p class="mcp-docs-hint">Claude Code discovers the server on its next interaction. Stop the server to remove the entry.</p>
        <h4>Approval Gates</h4>
        <p class="mcp-docs-hint">Gated tools pause execution and show a dialog. You can approve, reject, or the call auto-rejects after 5 minutes. Useful for destructive operations.</p>
      </div>
    </div>`;

    el.querySelector('#mcpAddEnv')?.addEventListener('click', () => {
      const tbody = el.querySelector('#mcpEnvTable');
      const row = document.createElement('tr');
      row.className = 'mcp-env-row';
      row.innerHTML = `<td><input type="text" placeholder="VAR_NAME" class="mcp-env-name"></td><td><input type="text" placeholder="value" class="mcp-env-value"></td><td style="text-align:center"><input type="checkbox" class="mcp-env-secret"></td><td><button class="mcp-env-del" title="Remove">&times;</button></td>`;
      row.querySelector('.mcp-env-del')?.addEventListener('click', () => row.remove());
      tbody.appendChild(row);
    });
    el.querySelectorAll('.mcp-env-del').forEach(btn => btn.addEventListener('click', () => btn.closest('tr').remove()));
  }

  function renderEnvRows(env, secrets) {
    let html = '';
    for (const [k, v] of Object.entries(env)) {
      html += `<tr class="mcp-env-row"><td><input type="text" value="${escHtml(k)}" class="mcp-env-name"></td><td><input type="text" value="${escHtml(v)}" class="mcp-env-value"></td><td style="text-align:center"><input type="checkbox" class="mcp-env-secret"></td><td><button class="mcp-env-del" title="Remove">&times;</button></td></tr>`;
    }
    for (const [k, v] of Object.entries(secrets)) {
      html += `<tr class="mcp-env-row"><td><input type="text" value="${escHtml(k)}" class="mcp-env-name"></td><td><input type="password" value="${escHtml(v)}" class="mcp-env-value"></td><td style="text-align:center"><input type="checkbox" class="mcp-env-secret" checked></td><td><button class="mcp-env-del" title="Remove">&times;</button></td></tr>`;
    }
    return html;
  }

  // ========== CODE TAB ==========

  function renderCodeTab() {
    const el = document.getElementById('mcpTabCode');
    if (!el) return;
    const s = mcp.servers.find(s => s.slug === mcp.editing) || {};

    el.innerHTML = `<div class="mcp-code-layout">
      <div class="mcp-file-list" id="mcpFileList"></div>
      <div class="mcp-editor-area">
        <textarea id="mcpEditor" class="cap-modal-code" spellcheck="false" placeholder="Select a file from the list to edit..."></textarea>
        <div class="mcp-output-panel" id="mcpOutput">${s.status === 'running' ? '' : '<div class="mcp-output-hint">Server is stopped. Start it to see output.</div>'}</div>
      </div>
      <div class="mcp-docs" style="padding:12px;border-left:1px solid var(--border)">
        <h4>Quick Reference</h4>
        <pre class="mcp-docs-pre">// Define a tool
server.tool(
  "name",
  "Description for Claude",
  {
    param: z.string()
      .describe("Param help"),
  },
  async ({ param }) => ({
    content: [{
      type: "text",
      text: "result"
    }],
  })
);</pre>
        <h4>Zod Schemas</h4>
        <pre class="mcp-docs-pre">z.string()
z.number()
z.boolean()
z.object({ key: z.string() })
z.array(z.string())
z.enum(["a", "b", "c"])

// Modifiers:
.optional()
.default("val")
.describe("Help text")</pre>
        <h4>Return Format</h4>
        <pre class="mcp-docs-pre">{
  content: [{
    type: "text",
    text: "Your result"
  }]
}</pre>
        <h4>Tips</h4>
        <p class="mcp-docs-hint">Use <code>Ctrl+S</code> to save. If the server is running, saving triggers a hot-reload.</p>
        <p class="mcp-docs-hint">Access env vars via <code>process.env.VAR_NAME</code>.</p>
        <p class="mcp-docs-hint">Import other files in the server directory with relative paths.</p>
      </div>
    </div>`;

    renderFileList();
    // Open server.js by default
    if (!mcp.activeFile && mcp.files.includes('server.js')) {
      sendWs({ type: 'mcp:file:read', slug: mcp.editing, path: 'server.js' });
    }
    // Render buffered output
    renderOutputBuffer();

    el.querySelector('#mcpEditor')?.addEventListener('input', () => { mcp.unsaved = true; });
  }

  function renderFileList() {
    const list = document.getElementById('mcpFileList');
    if (!list) return;
    let html = '';
    for (const f of mcp.files) {
      html += `<div class="mcp-file-item${f === mcp.activeFile ? ' active' : ''}" data-path="${escHtml(f)}">${escHtml(f)}</div>`;
    }
    html += `<div class="mcp-file-add" id="mcpFileAdd">+ New File</div>`;
    list.innerHTML = html;
    list.querySelectorAll('.mcp-file-item').forEach(item => {
      item.addEventListener('click', () => {
        sendWs({ type: 'mcp:file:read', slug: mcp.editing, path: item.dataset.path });
      });
    });
    list.querySelector('#mcpFileAdd')?.addEventListener('click', () => {
      const name = prompt('File name:', 'utils.js');
      if (!name) return;
      sendWs({ type: 'mcp:file:create', slug: mcp.editing, path: name, content: '' });
    });
  }

  function setEditorContent(content) {
    const ed = document.getElementById('mcpEditor');
    if (ed) ed.value = content;
    mcp.unsaved = false;
    // Update active state in file list
    document.querySelectorAll('.mcp-file-item').forEach(item => {
      item.classList.toggle('active', item.dataset.path === mcp.activeFile);
    });
  }

  function saveCurrentFile() {
    if (!mcp.editing || !mcp.activeFile) return;
    const ed = document.getElementById('mcpEditor');
    if (!ed) return;
    sendWs({ type: 'mcp:file:write', slug: mcp.editing, path: mcp.activeFile, content: ed.value });
    mcp.unsaved = false;
  }

  function saveAll() {
    // Save current file if open
    saveCurrentFile();
    // Save meta from Setup tab
    if (mcp.editMeta) {
      const updates = collectSetupValues();
      // Action bar name takes precedence (always visible, user edits it directly)
      const modalName = document.getElementById('mcpModalName')?.value?.trim();
      if (modalName) updates.name = modalName;
      sendWs({ type: 'mcp:update', slug: mcp.editing, updates });
      // Visual feedback — mcp:updated handler sets unsaved=false and re-renders action bar
      const btn = document.getElementById('mcpBtnSave');
      if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
    }
  }

  function collectSetupValues() {
    const updates = {};
    const name = document.getElementById('mcpSetupName')?.value?.trim();
    if (name) updates.name = name;
    const desc = document.getElementById('mcpSetupDesc')?.value?.trim();
    if (desc !== undefined) updates.description = desc;
    const icon = document.getElementById('mcpSetupIcon')?.value?.trim();
    if (icon) updates.icon = icon;
    updates.scope = document.getElementById('mcpSetupScope')?.value || 'user';
    updates.autoRegister = document.getElementById('mcpSetupAutoReg')?.checked ?? true;
    updates.autoStart = document.getElementById('mcpSetupAutoStart')?.checked ?? false;
    // Env vars
    updates.env = {};
    updates.secrets = {};
    document.querySelectorAll('#mcpEnvTable .mcp-env-row').forEach(row => {
      const k = row.querySelector('.mcp-env-name')?.value?.trim();
      const v = row.querySelector('.mcp-env-value')?.value || '';
      const secret = row.querySelector('.mcp-env-secret')?.checked;
      if (k) { if (secret) updates.secrets[k] = v; else updates.env[k] = v; }
    });
    const approval = document.getElementById('mcpSetupApproval')?.value?.trim();
    updates.approvalRequired = approval ? approval.split(',').map(s => s.trim()).filter(Boolean) : [];
    return updates;
  }

  function appendOutput(data, stream) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    mcp.output.push({ ts, data, stream });
    renderOutputBuffer();
  }

  function renderOutputBuffer() {
    const panel = document.getElementById('mcpOutput');
    if (!panel) return;
    if (mcp.output.length === 0) {
      const s = mcp.servers.find(s => s.slug === mcp.editing) || {};
      panel.innerHTML = s.status === 'running' ? '' : '<div class="mcp-output-hint">Server is stopped. Start it to see output.</div>';
      return;
    }
    panel.innerHTML = mcp.output.map(o =>
      `<div${o.stream === 'stderr' ? ' class="mcp-out-err"' : ''}><span class="mcp-out-time">[${o.ts}]</span>${escHtml(o.data)}</div>`
    ).join('');
    panel.scrollTop = panel.scrollHeight;
  }

  // ========== TESTING TAB ==========

  function renderTestingTab() {
    const el = document.getElementById('mcpTabTesting');
    if (!el) return;
    const s = mcp.servers.find(s => s.slug === mcp.editing) || {};
    const running = s.status === 'running';

    let toolOptions = running && mcp.tools.length
      ? mcp.tools.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('')
      : '<option value="">—</option>';

    el.innerHTML = `<div class="mcp-test-area">
      <div class="mcp-test-hint">Test your tools directly &mdash; no need to involve Claude Code. Select a tool, fill in parameters, and execute.</div>
      <div class="mcp-test-row"><label>Tool:</label><select id="mcpTestTool" ${running ? '' : 'disabled'}>${toolOptions}</select></div>
      ${!running ? '<div class="mcp-test-hint" style="color:var(--yellow)">Start the server to test tools.</div>' : ''}
      <div id="mcpTestDesc"></div>
      <div id="mcpTestParams"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="mcp-action-btn primary" id="mcpTestExec" ${running ? '' : 'disabled'}>&#9654; Execute</button>
      </div>
      <div id="mcpTestResult"></div>
      <div class="mcp-test-history" id="mcpTestHistory"></div>
    </div>`;

    const toolSel = el.querySelector('#mcpTestTool');
    toolSel?.addEventListener('change', () => renderTestParams(toolSel.value));
    if (running && mcp.tools.length) renderTestParams(mcp.tools[0].name);
    el.querySelector('#mcpTestExec')?.addEventListener('click', executeTest);
    renderTestHistory();
    if (mcp.testResult) renderTestResult();
  }

  function renderTestParams(toolName) {
    const tool = mcp.tools.find(t => t.name === toolName);
    const descEl = document.getElementById('mcpTestDesc');
    const paramsEl = document.getElementById('mcpTestParams');
    if (!tool || !descEl || !paramsEl) return;

    descEl.innerHTML = `<div class="mcp-test-desc">${escHtml(tool.description || '')}</div>`;
    const schema = tool.inputSchema?.properties || {};
    const required = tool.inputSchema?.required || [];
    let html = '<div class="mcp-test-params">';
    for (const [name, prop] of Object.entries(schema)) {
      const type = prop.type || 'string';
      const req = required.includes(name);
      const desc = prop.description || '';
      html += `<div class="mcp-test-param-field">
        <div class="mcp-test-param-label">${escHtml(name)} <span class="mcp-param-type">${type}</span>${req ? ' <span class="mcp-param-req">required</span>' : ''}</div>
        ${desc ? `<div class="mcp-form-hint">${escHtml(desc)}</div>` : ''}`;
      if (type === 'boolean') {
        html += `<label><input type="checkbox" data-param="${name}" data-type="boolean"> true</label>`;
      } else if (type === 'object' || type === 'array') {
        html += `<textarea data-param="${name}" data-type="${type}" rows="3" placeholder="JSON">{}</textarea>`;
      } else if (type === 'number') {
        html += `<input type="number" data-param="${name}" data-type="number" placeholder="0">`;
      } else {
        html += `<input type="text" data-param="${name}" data-type="string" placeholder="${escHtml(desc || '')}">`;
      }
      html += '</div>';
    }
    html += '</div>';
    paramsEl.innerHTML = html;
  }

  function executeTest() {
    const toolSel = document.getElementById('mcpTestTool');
    if (!toolSel?.value) return;
    const params = {};
    document.querySelectorAll('#mcpTestParams [data-param]').forEach(el => {
      const name = el.dataset.param;
      const type = el.dataset.type;
      if (type === 'boolean') params[name] = el.checked;
      else if (type === 'number') params[name] = parseFloat(el.value) || 0;
      else if (type === 'object' || type === 'array') { try { params[name] = JSON.parse(el.value); } catch { params[name] = el.value; } }
      else params[name] = el.value;
    });
    sendWs({ type: 'mcp:test', slug: mcp.editing, tool: toolSel.value, params });
  }

  function renderTestResult() {
    const el = document.getElementById('mcpTestResult');
    if (!el || !mcp.testResult) return;
    const r = mcp.testResult;
    const ok = !r.error;
    el.innerHTML = `<div class="mcp-test-result">
      <div class="mcp-test-result-header">
        <span class="${ok ? 'mcp-res-ok' : 'mcp-res-err'}">${ok ? '✓ Success' : '✕ Error'}</span>
        <span class="mcp-res-ms">${r.latencyMs || 0}ms</span>
      </div>
      <div class="mcp-test-result-body">${escHtml(JSON.stringify(r.error || r.result, null, 2))}</div>
    </div>`;
  }

  function renderTestHistory() {
    const el = document.getElementById('mcpTestHistory');
    if (!el) return;
    if (!mcp.testHistory.length) { el.innerHTML = ''; return; }
    let html = '<h4>History</h4>';
    for (const h of mcp.testHistory.slice(0, 20)) {
      const t = new Date(h.timestamp).toLocaleTimeString('en-US', { hour12: false });
      html += `<div class="mcp-test-history-item"><span>${t}</span><span>${escHtml(h.tool)}</span><span>${h.status === 'success' ? '✓' : '✕'}</span><span>${h.latencyMs || 0}ms</span></div>`;
    }
    el.innerHTML = html;
  }

  // ========== LOGS TAB ==========

  function renderLogsTab() {
    const el = document.getElementById('mcpTabLogs');
    if (!el) return;
    el.innerHTML = `<div class="mcp-logs-area">
      <div class="mcp-logs-hint">All tool calls from Claude Code and test invocations are logged here. Logs are stored as daily JSONL files in <code>mcp-servers/${escHtml(mcp.editing)}/logs/</code>.</div>
      <div class="mcp-logs-filters">
        <select id="mcpLogTool"><option value="">All Tools</option></select>
        <select id="mcpLogStatus"><option value="">All</option><option value="success">Success</option><option value="error">Error</option></select>
        <input type="text" id="mcpLogSearch" placeholder="Search logs...">
        <button class="mcp-action-btn" id="mcpLogRefresh">Refresh</button>
        <button class="mcp-action-btn" id="mcpLogClear">Clear</button>
      </div>
      <div id="mcpLogEntries"></div>
      <div class="mcp-logs-stats" id="mcpLogStats"></div>
    </div>`;

    // Populate tool filter from log entries
    const tools = [...new Set(mcp.logs.entries.map(e => e.tool).filter(Boolean))];
    const toolSel = el.querySelector('#mcpLogTool');
    for (const t of tools) toolSel.add(new Option(t, t));

    el.querySelector('#mcpLogRefresh')?.addEventListener('click', () => {
      sendWs({ type: 'mcp:logs', slug: mcp.editing, opts: collectLogFilters() });
      sendWs({ type: 'mcp:logs:stats', slug: mcp.editing });
    });
    el.querySelector('#mcpLogClear')?.addEventListener('click', () => {
      if (confirm('Clear all logs for this server?')) sendWs({ type: 'mcp:logs:clear', slug: mcp.editing });
    });
    [el.querySelector('#mcpLogTool'), el.querySelector('#mcpLogStatus'), el.querySelector('#mcpLogSearch')].forEach(f => {
      f?.addEventListener('change', () => sendWs({ type: 'mcp:logs', slug: mcp.editing, opts: collectLogFilters() }));
    });

    renderLogEntries();
    renderLogStats();
  }

  function collectLogFilters() {
    return {
      tool: document.getElementById('mcpLogTool')?.value || undefined,
      status: document.getElementById('mcpLogStatus')?.value || undefined,
      search: document.getElementById('mcpLogSearch')?.value || undefined,
      limit: 50,
    };
  }

  function renderLogEntries() {
    const el = document.getElementById('mcpLogEntries');
    if (!el) return;
    if (!mcp.logs.entries.length) {
      el.innerHTML = '<div class="mcp-logs-empty">No log entries yet. Tool calls from Claude Code and test invocations will appear here.</div>';
      return;
    }
    el.innerHTML = mcp.logs.entries.map((e, i) => {
      const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const src = e.source === 'test' ? 'test' : 'claude-code';
      return `<div class="mcp-log-entry" data-idx="${i}">
        <span class="mcp-log-time">${t}</span>
        <span class="mcp-log-source ${src}">${e.source === 'test' ? 'Test' : 'Claude Code'}</span>
        <span class="mcp-log-tool">${escHtml(e.tool || '')}</span>
        <span class="${e.status === 'error' ? 'mcp-log-status-err' : 'mcp-log-status-ok'}">${e.status === 'error' ? '✕' : '✓'}</span>
        <span class="mcp-log-ms">${e.latencyMs || 0}ms</span>
      </div>`;
    }).join('');
    el.querySelectorAll('.mcp-log-entry').forEach(row => row.addEventListener('click', () => toggleLogDetail(row)));
  }

  function toggleLogDetail(row) {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains('mcp-log-detail')) { existing.remove(); return; }
    const idx = parseInt(row.dataset.idx);
    const e = mcp.logs.entries[idx];
    if (!e) return;
    const detail = document.createElement('div');
    detail.className = 'mcp-log-detail';
    detail.innerHTML = `<div><h5>Request</h5>${escHtml(JSON.stringify(e.request, null, 2))}</div><div><h5>Response</h5>${escHtml(JSON.stringify(e.response, null, 2))}</div>`;
    row.after(detail);
  }

  function renderLogStats() {
    const el = document.getElementById('mcpLogStats');
    if (!el || !mcp.logStats) return;
    const s = mcp.logStats;
    el.innerHTML = `<span>Total: <strong>${s.totalCalls}</strong></span>
      <span>Errors: <strong>${s.errorRate}%</strong></span>
      <span>Avg latency: <strong>${s.avgLatency}ms</strong></span>`;
  }

  // ========== DEPS TAB ==========

  function renderDepsTab() {
    const el = document.getElementById('mcpTabDeps');
    if (!el) return;

    el.innerHTML = `<div class="mcp-columns">
      <div class="mcp-main">
        <div class="mcp-form-hint">These packages are installed in the server's own <code>node_modules/</code> directory. The MCP SDK and Zod are provided by the host app &mdash; no install needed.</div>
        <table class="mcp-deps-table" id="mcpDepsTable">
          <tr><th>Package</th><th>Version</th><th>Status</th><th></th></tr>
          <tr><td>@modelcontextprotocol/sdk</td><td>bundled</td><td><span class="mcp-dep-bundled">✓ bundled</span></td><td></td></tr>
          <tr><td>zod</td><td>bundled</td><td><span class="mcp-dep-bundled">✓ bundled</span></td><td></td></tr>
        </table>
        <div class="mcp-deps-add">
          <input type="text" id="mcpDepName" placeholder="package-name" style="flex:1">
          <input type="text" id="mcpDepVer" placeholder="^1.0.0" style="width:80px">
          <button class="mcp-action-btn" id="mcpDepInstall">+ Install</button>
          <button class="mcp-action-btn" id="mcpDepInstallAll" title="Run npm install in the server directory">📦 Install All</button>
        </div>
        <div class="mcp-deps-output" id="mcpDepOutput" style="display:${mcp.depOutput ? 'block' : 'none'}">${escHtml(mcp.depOutput)}</div>
      </div>
      <div class="mcp-docs">
        <h4>How It Works</h4>
        <p class="mcp-docs-hint">Each server has its own <code>package.json</code> and <code>node_modules/</code>. Dependencies are isolated per-server.</p>
        <h4>Bundled Packages</h4>
        <p class="mcp-docs-hint">The MCP SDK and Zod are resolved from the host app's <code>node_modules</code> &mdash; shared, not duplicated. They're always available in your server code.</p>
        <h4>Adding Packages</h4>
        <p class="mcp-docs-hint">Type a package name and click Install. Version is optional (defaults to latest). <strong>Install All</strong> runs <code>npm install</code> in the server directory.</p>
        <h4>Import in Code</h4>
        <pre class="mcp-docs-pre">// Bundled (always available):
import { McpServer } from
  "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Custom deps (after install):
import cheerio from "cheerio";</pre>
      </div>
    </div>`;

    renderDepsTable();

    el.querySelector('#mcpDepInstall')?.addEventListener('click', () => {
      const pkg = document.getElementById('mcpDepName')?.value?.trim();
      if (!pkg) return;
      const ver = document.getElementById('mcpDepVer')?.value?.trim();
      mcp.depOutput = '';
      sendWs({ type: 'mcp:deps:install', slug: mcp.editing, package: pkg, version: ver || undefined });
    });
    el.querySelector('#mcpDepInstallAll')?.addEventListener('click', () => {
      mcp.depOutput = '';
      sendWs({ type: 'mcp:deps:install-all', slug: mcp.editing });
    });
  }

  function renderDepsTable() {
    const table = document.getElementById('mcpDepsTable');
    if (!table) return;
    // Remove user dep rows (keep header + bundled)
    table.querySelectorAll('.mcp-dep-user').forEach(r => r.remove());
    for (const dep of mcp.deps) {
      const row = document.createElement('tr');
      row.className = 'mcp-dep-user';
      row.innerHTML = `<td>${escHtml(dep.name)}</td><td>${escHtml(dep.version)}</td><td><span class="mcp-dep-installed">✓ installed</span></td><td><button class="mcp-env-del mcp-dep-rm" data-pkg="${escHtml(dep.name)}" title="Uninstall">&times;</button></td>`;
      row.querySelector('.mcp-dep-rm')?.addEventListener('click', () => {
        sendWs({ type: 'mcp:deps:uninstall', slug: mcp.editing, package: dep.name });
      });
      table.appendChild(row);
    }
  }

  function renderDepOutput() {
    const el = document.getElementById('mcpDepOutput');
    if (!el) return;
    el.style.display = mcp.depOutput ? 'block' : 'none';
    el.textContent = mcp.depOutput;
    el.scrollTop = el.scrollHeight;
  }

  // --- Export module ---
  window.mcpModule = { handleMessage };
})();
