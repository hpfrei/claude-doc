const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const ClaudeSession = require('./src/claude-session');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3457');
const TARGET_URL = process.env.ANTHROPIC_TARGET_URL || 'https://api.anthropic.com';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '200');

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
dashboardApp.use(express.static(path.join(__dirname, 'public')));
const dashboardServer = http.createServer(dashboardApp);

// Claude session (spawns claude -p through the proxy)
const claudeSession = new ClaudeSession(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) });

// WebSocket server on dashboard
const wss = new WebSocketServer({ server: dashboardServer });
broadcaster = new DashboardBroadcaster(wss, store, claudeSession);

// Fix circular ref: point session's broadcaster at the real one
claudeSession.broadcaster = broadcaster;

// Start both servers
proxyServer.listen(PROXY_PORT, () => {
  dashboardServer.listen(DASHBOARD_PORT, () => {
    console.log('');
    console.log('  Claude Code API Proxy running.');
    console.log('');
    console.log(`  Proxy:     http://localhost:${PROXY_PORT}`);
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`  Upstream:  ${TARGET_URL}`);
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
