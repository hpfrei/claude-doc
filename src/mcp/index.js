const servers = require('./servers');
const registrar = require('./registrar');
const logs = require('./logs');
const templates = require('./templates');
const path = require('path');

let broadcaster = null;
let opts = {};

function init(options) {
  opts = options;
  broadcaster = options.broadcaster;
  // Register this module as the mcp handler on the broadcaster
  broadcaster.mcpHandler = { onConnect, handleMessage };
  // Ensure servers directory exists
  servers.getServersDir();
}

function onConnect(ws) {
  const serverList = servers.listServers();
  const templateList = templates.listTemplates();
  ws.send(JSON.stringify({ type: 'mcp:list', servers: serverList }));
  ws.send(JSON.stringify({ type: 'mcp:templates', templates: templateList }));
}

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const broadcast = (data) => bc.broadcast(data);

  try {
    switch (msg.type) {
      // --- Server CRUD ---
      case 'mcp:list':
        send({ type: 'mcp:list', servers: servers.listServers() });
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
          broadcast({ type: 'mcp:list', servers: servers.listServers() });
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
          broadcast({ type: 'mcp:list', servers: servers.listServers() });
          send({ type: 'mcp:updated', server: result });
        }
        break;
      }

      case 'mcp:delete': {
        const result = servers.deleteServer(msg.slug);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcast({ type: 'mcp:list', servers: servers.listServers() });
        }
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

function shutdown() {
  // Phase 2: stop all workers, unregister
}

module.exports = { init, shutdown };
