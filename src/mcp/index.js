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

module.exports = { init, shutdown };
