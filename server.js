const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const ClaudeSession = require('./src/claude-session');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456');
const DASHBOARD_PORT = parseInt(process.argv[2] || process.env.DASHBOARD_PORT || '3457');
const TARGET_URL = process.env.ANTHROPIC_TARGET_URL || 'https://api.anthropic.com';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '200');
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomUUID();
const AUTH_TOKEN_SOURCE = process.env.AUTH_TOKEN ? 'env' : 'generated';

// Shared store
const store = new InteractionStore(MAX_HISTORY);

// --- Proxy server (port 3456) ---
const proxyApp = express();
let broadcaster = { broadcast() {} };
const proxyRouter = createProxyRouter(store, { broadcast: (...args) => broadcaster.broadcast(...args) }, TARGET_URL);
proxyApp.use(proxyRouter);
const proxyServer = http.createServer(proxyApp);

// --- Dashboard server (port 3457) ---
const dashboardApp = express();
dashboardApp.use(express.urlencoded({ extended: false }));

// Auth: cookie parser helper
function getTokenFromCookies(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? match[1] : null;
}

// Login routes (no auth required)
dashboardApp.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

dashboardApp.post('/login', (req, res) => {
  if (req.body.token === AUTH_TOKEN) {
    res.setHeader('Set-Cookie', `token=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// Auth middleware for all other routes
dashboardApp.use((req, res, next) => {
  const token = getTokenFromCookies(req.headers.cookie);
  if (token === AUTH_TOKEN) return next();
  res.redirect('/login');
});

dashboardApp.use(express.static(path.join(__dirname, 'public')));
const dashboardServer = http.createServer(dashboardApp);

// Claude session (spawns claude -p through the proxy)
const claudeSession = new ClaudeSession(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store);

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, claudeSession);

dashboardServer.on('upgrade', (req, socket, head) => {
  const token = getTokenFromCookies(req.headers.cookie);
  if (token !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Fix circular ref: point session's broadcaster at the real one
claudeSession.broadcaster = broadcaster;

// Start both servers (proxy on localhost only)
proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  dashboardServer.listen(DASHBOARD_PORT, () => {
    claudeSession.setReady();
    console.log('');
    console.log('  Claude Code API Proxy running.');
    console.log('');
    console.log(`  Proxy:     http://127.0.0.1:${PROXY_PORT} (localhost only)`);
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`  Upstream:  ${TARGET_URL}`);
    console.log('');
    if (AUTH_TOKEN_SOURCE === 'generated') {
      console.log(`  Auth token (auto-generated):`);
    } else {
      console.log(`  Auth token (from AUTH_TOKEN env):`);
    }
    console.log(`  ${AUTH_TOKEN}`);
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} claude -p "your prompt"`);
    console.log('');
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
