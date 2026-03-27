const servers = require('./servers');
const registrar = require('./registrar');
const logs = require('./logs');
const templates = require('./templates');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let broadcaster = null;
let opts = {};

// Track running servers: slug → { startedAt, registered }
const running = new Map();

function init(options) {
  opts = options;
  broadcaster = options.broadcaster;
  // Register this module as the mcp handler on the broadcaster
  broadcaster.mcpHandler = { onConnect, handleMessage };
  // Ensure servers directory exists
  servers.getServersDir();
}

function enrichWithStatus(serverList) {
  return serverList.map(s => ({
    ...s,
    status: running.has(s.slug) ? 'running' : 'stopped',
  }));
}

function onConnect(ws) {
  const serverList = enrichWithStatus(servers.listServers());
  const templateList = templates.listTemplates();
  ws.send(JSON.stringify({ type: 'mcp:list', servers: serverList }));
  ws.send(JSON.stringify({ type: 'mcp:templates', templates: templateList }));
}

function broadcastServerList(broadcast) {
  broadcast({ type: 'mcp:list', servers: enrichWithStatus(servers.listServers()) });
}

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const broadcast = (data) => bc.broadcast(data);

  try {
    switch (msg.type) {
      // --- Server CRUD ---
      case 'mcp:list':
        send({ type: 'mcp:list', servers: enrichWithStatus(servers.listServers()) });
        break;

      case 'mcp:create': {
        const result = servers.createServer(
          msg.name,
          msg.template,
          msg.template ? (tpl, dir, slug) => templates.instantiate(tpl, dir, slug) : null
        );
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastServerList(broadcast);
          send({ type: 'mcp:created', server: result });
        }
        break;
      }

      case 'mcp:load': {
        const server = servers.loadServer(msg.slug);
        if (!server) {
          send({ type: 'mcp:error', error: 'Server not found.' });
        } else {
          send({ type: 'mcp:loaded', server });
        }
        break;
      }

      case 'mcp:update': {
        const result = servers.updateServer(msg.slug, msg.updates);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastServerList(broadcast);
          send({ type: 'mcp:updated', server: result });
        }
        break;
      }

      case 'mcp:delete': {
        // Stop if running
        if (running.has(msg.slug)) {
          stopServer(msg.slug);
        }
        const result = servers.deleteServer(msg.slug);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastServerList(broadcast);
        }
        break;
      }

      // --- Server Lifecycle ---
      case 'mcp:start':
        startServer(msg.slug, send, broadcast);
        break;

      case 'mcp:stop':
        stopServer(msg.slug);
        broadcast({ type: 'mcp:status', slug: msg.slug, status: 'stopped' });
        broadcastServerList(broadcast);
        break;

      case 'mcp:restart':
        stopServer(msg.slug);
        startServer(msg.slug, send, broadcast);
        break;

      // --- Tool Discovery & Testing ---
      case 'mcp:tools':
        probeTools(msg.slug).then(tools => {
          send({ type: 'mcp:tools', slug: msg.slug, tools });
        }).catch(err => {
          send({ type: 'mcp:error', error: `Tool discovery failed: ${err.message}` });
        });
        break;

      case 'mcp:test': {
        const start = Date.now();
        testTool(msg.slug, msg.tool, msg.params).then(result => {
          send({ type: 'mcp:test:result', slug: msg.slug, tool: msg.tool, result, latencyMs: Date.now() - start });
        }).catch(err => {
          send({ type: 'mcp:test:result', slug: msg.slug, tool: msg.tool, error: err.message, latencyMs: Date.now() - start });
        });
        break;
      }

      // --- File Operations ---
      case 'mcp:file:list':
        send({ type: 'mcp:file:list', slug: msg.slug, files: servers.listFiles(msg.slug) });
        break;

      case 'mcp:file:read': {
        const result = servers.readFile(msg.slug, msg.path);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:content', slug: msg.slug, ...result });
        }
        break;
      }

      case 'mcp:file:write': {
        const result = servers.writeFile(msg.slug, msg.path, msg.content);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:written', slug: msg.slug, path: result.path });
          // Refresh file list
          send({ type: 'mcp:file:list', slug: msg.slug, files: servers.listFiles(msg.slug) });
        }
        break;
      }

      case 'mcp:file:delete': {
        const result = servers.deleteFile(msg.slug, msg.path);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:list', slug: msg.slug, files: servers.listFiles(msg.slug) });
        }
        break;
      }

      case 'mcp:file:create': {
        const result = servers.writeFile(msg.slug, msg.path, msg.content || '');
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:list', slug: msg.slug, files: servers.listFiles(msg.slug) });
          send({ type: 'mcp:file:content', slug: msg.slug, content: msg.content || '', path: result.path });
        }
        break;
      }

      // --- Logs ---
      case 'mcp:logs': {
        const dir = servers.serverDir(msg.slug);
        const result = logs.readLogs(dir, msg.opts || {});
        send({ type: 'mcp:logs:result', slug: msg.slug, ...result });
        break;
      }

      case 'mcp:logs:stats': {
        const dir = servers.serverDir(msg.slug);
        const stats = logs.getStats(dir);
        send({ type: 'mcp:logs:stats', slug: msg.slug, stats });
        break;
      }

      case 'mcp:logs:clear': {
        const dir = servers.serverDir(msg.slug);
        logs.clearLogs(dir);
        send({ type: 'mcp:logs:result', slug: msg.slug, entries: [], total: 0 });
        break;
      }

      // --- Dependencies ---
      case 'mcp:deps:list':
        send({ type: 'mcp:deps:list', slug: msg.slug, deps: servers.listDeps(msg.slug) });
        break;

      case 'mcp:deps:install':
        send({ type: 'mcp:dep-progress', slug: msg.slug, package: msg.package, status: 'installing', output: '' });
        servers.installDep(
          msg.slug, msg.package, msg.version,
          (data) => send({ type: 'mcp:dep-progress', slug: msg.slug, package: msg.package, status: 'installing', output: data }),
          (ok) => {
            send({ type: 'mcp:dep-progress', slug: msg.slug, package: msg.package, status: ok ? 'installed' : 'failed', output: '' });
            send({ type: 'mcp:deps:list', slug: msg.slug, deps: servers.listDeps(msg.slug) });
          }
        );
        break;

      case 'mcp:deps:uninstall':
        servers.uninstallDep(
          msg.slug, msg.package,
          (data) => send({ type: 'mcp:dep-progress', slug: msg.slug, package: msg.package, status: 'uninstalling', output: data }),
          (ok) => {
            send({ type: 'mcp:deps:list', slug: msg.slug, deps: servers.listDeps(msg.slug) });
          }
        );
        break;

      case 'mcp:deps:install-all':
        send({ type: 'mcp:dep-progress', slug: msg.slug, package: '*', status: 'installing', output: '' });
        servers.installAll(
          msg.slug,
          (data) => send({ type: 'mcp:dep-progress', slug: msg.slug, package: '*', status: 'installing', output: data }),
          (ok) => {
            send({ type: 'mcp:dep-progress', slug: msg.slug, package: '*', status: ok ? 'installed' : 'failed', output: '' });
            send({ type: 'mcp:deps:list', slug: msg.slug, deps: servers.listDeps(msg.slug) });
          }
        );
        break;
    }
  } catch (err) {
    console.error('MCP handler error:', err);
    send({ type: 'mcp:error', error: err.message });
  }
}

// --- Server Lifecycle ---

function startServer(slug, send, broadcast) {
  if (running.has(slug)) {
    send({ type: 'mcp:error', error: 'Server is already running.' });
    return;
  }

  const meta = servers.loadServer(slug);
  if (!meta) {
    send({ type: 'mcp:error', error: 'Server not found.' });
    return;
  }

  const dir = servers.serverDir(slug);
  const nodeModules = path.join(dir, 'node_modules');

  // Install deps if node_modules doesn't exist
  if (!fs.existsSync(nodeModules)) {
    broadcast({ type: 'mcp:status', slug, status: 'installing' });
    broadcast({ type: 'mcp:output', slug, data: 'Installing dependencies...\n', stream: 'stdout' });

    const install = spawn('npm', ['install'], { cwd: dir, shell: true });
    install.stdout.on('data', d => broadcast({ type: 'mcp:output', slug, data: d.toString(), stream: 'stdout' }));
    install.stderr.on('data', d => broadcast({ type: 'mcp:output', slug, data: d.toString(), stream: 'stderr' }));
    install.on('close', code => {
      if (code !== 0) {
        broadcast({ type: 'mcp:status', slug, status: 'error', error: 'npm install failed' });
        broadcast({ type: 'mcp:output', slug, data: `npm install exited with code ${code}\n`, stream: 'stderr' });
        broadcastServerList(broadcast);
        return;
      }
      broadcast({ type: 'mcp:output', slug, data: 'Dependencies installed.\n', stream: 'stdout' });
      finishStart(slug, meta, send, broadcast);
    });
  } else {
    finishStart(slug, meta, send, broadcast);
  }
}

function finishStart(slug, meta, send, broadcast) {
  const appRoot = path.dirname(path.dirname(__dirname));
  const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');
  const projectDir = opts.claudeSession?.cwd || process.cwd();

  // Register with Claude Code config
  const regResult = registrar.register(
    slug, meta, bridgePath,
    opts.authToken || '', opts.dashboardPort || 3457, projectDir
  );

  if (!regResult.ok) {
    send({ type: 'mcp:error', error: 'Failed to register server.' });
    return;
  }

  running.set(slug, { startedAt: Date.now(), registered: true });
  broadcast({ type: 'mcp:status', slug, status: 'running' });
  broadcast({ type: 'mcp:output', slug, data: `Registered with Claude Code (${regResult.configPath}).\nServer is ready — Claude Code will spawn it on first tool call.\n`, stream: 'stdout' });
  broadcastServerList(broadcast);

  // Probe for available tools
  broadcast({ type: 'mcp:output', slug, data: 'Discovering tools...\n', stream: 'stdout' });
  probeTools(slug).then(tools => {
    broadcast({ type: 'mcp:tools', slug, tools });
    broadcast({ type: 'mcp:output', slug, data: `Found ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}\n`, stream: 'stdout' });
  }).catch(err => {
    broadcast({ type: 'mcp:output', slug, data: `Tool discovery failed: ${err.message}\n`, stream: 'stderr' });
  });
}

function stopServer(slug) {
  const meta = servers.loadServer(slug);
  const projectDir = opts.claudeSession?.cwd || process.cwd();

  if (meta) {
    registrar.unregister(slug, meta.scope || 'user', projectDir);
  }

  running.delete(slug);
}

function shutdown() {
  // Unregister all running servers on dashboard shutdown
  const projectDir = opts.claudeSession?.cwd || process.cwd();
  for (const slug of running.keys()) {
    const meta = servers.loadServer(slug);
    if (meta) registrar.unregister(slug, meta.scope || 'user', projectDir);
  }
  running.clear();
}

// --- MCP JSON-RPC helpers (tool discovery & testing) ---

function spawnBridge(slug) {
  const appRoot = path.dirname(path.dirname(__dirname));
  const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');
  return spawn('node', [bridgePath, slug], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_DOC_SERVER_SLUG: slug },
  });
}

function sendJsonRpc(proc, method, params, id) {
  const msg = { jsonrpc: '2.0', method };
  if (id !== undefined) msg.id = id;
  if (params !== undefined) msg.params = params;
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

function waitForResponse(proc, id, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for MCP response'));
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.removeListener('data', onData);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
    }

    function onData(data) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
            return;
          }
        } catch { /* skip non-JSON lines */ }
      }
    }

    function onError(err) { cleanup(); reject(err); }
    function onClose(code) { cleanup(); reject(new Error(`Bridge exited with code ${code}`)); }

    proc.stdout.on('data', onData);
    proc.on('error', onError);
    proc.on('close', onClose);
  });
}

async function mcpInitialize(proc) {
  sendJsonRpc(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-doc', version: '1.0.0' },
  }, 1);
  await waitForResponse(proc, 1);
  sendJsonRpc(proc, 'notifications/initialized');
}

async function probeTools(slug) {
  const proc = spawnBridge(slug);
  try {
    await mcpInitialize(proc);
    sendJsonRpc(proc, 'tools/list', {}, 2);
    const result = await waitForResponse(proc, 2);
    return result.tools || [];
  } finally {
    proc.kill();
  }
}

async function testTool(slug, toolName, args) {
  const proc = spawnBridge(slug);
  try {
    await mcpInitialize(proc);
    sendJsonRpc(proc, 'tools/call', { name: toolName, arguments: args }, 2);
    const result = await waitForResponse(proc, 2);
    return result;
  } finally {
    proc.kill();
  }
}

module.exports = { init, shutdown };
