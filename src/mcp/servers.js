const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Base directory for all MCP server data
let serversDir = null;

function getServersDir() {
  if (!serversDir) {
    serversDir = path.join(path.dirname(path.dirname(__dirname)), 'mcp-servers');
    if (!fs.existsSync(serversDir)) fs.mkdirSync(serversDir, { recursive: true });
  }
  return serversDir;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function validateSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 2 && slug.length <= 50;
}

function serverDir(slug) {
  return path.join(getServersDir(), slug);
}

function metaPath(slug) {
  return path.join(serverDir(slug), 'meta.json');
}

function readMeta(slug) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(slug), 'utf8'));
  } catch { return null; }
}

function writeMeta(slug, meta) {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(slug), JSON.stringify(meta, null, 2));
}

// --- CRUD ---

function listServers() {
  const dir = getServersDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => {
      const p = path.join(dir, name, 'meta.json');
      return fs.existsSync(p);
    })
    .map(name => {
      const meta = readMeta(name);
      return meta ? { slug: name, name: meta.name, icon: meta.icon || '🔧', description: meta.description || '', status: 'stopped', toolCount: 0, ...meta } : null;
    })
    .filter(Boolean);
}

function loadServer(slug) {
  const meta = readMeta(slug);
  if (!meta) return null;
  return { ...meta, slug };
}

function createServer(name, templateName, templatesFn) {
  const slug = slugify(name);
  if (!validateSlug(slug)) return { error: 'Invalid name. Use lowercase letters, numbers, hyphens. Min 2 chars.' };

  const dir = serverDir(slug);
  if (fs.existsSync(dir)) return { error: `Server "${slug}" already exists.` };

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  // Copy template or use blank default
  if (templateName && templatesFn) {
    const ok = templatesFn(templateName, dir, slug);
    if (!ok) {
      // Fallback to blank
      writeDefaultFiles(dir, slug);
    }
  } else {
    writeDefaultFiles(dir, slug);
  }

  const meta = {
    slug,
    name,
    description: '',
    icon: '🔧',
    version: '1.0.0',
    scope: 'user',
    autoStart: false,
    autoRegister: true,
    env: {},
    secrets: {},
    approvalRequired: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMeta(slug, meta);

  return { slug, ...meta };
}

function writeDefaultFiles(dir, slug) {
  // Default server.js
  const serverCode = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "${slug}",
  version: "1.0.0",
});

server.tool(
  "hello",
  "A simple test tool that greets by name",
  {
    name: z.string().describe("Name to greet"),
  },
  async ({ name }) => {
    return {
      content: [{ type: "text", text: \`Hello, \${name}!\` }],
    };
  }
);

export default server;
`;
  fs.writeFileSync(path.join(dir, 'server.js'), serverCode);

  // Default package.json
  const pkg = {
    name: slug,
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.12.1',
      'zod': '^3.24.4',
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

function updateServer(slug, updates) {
  const meta = readMeta(slug);
  if (!meta) return { error: 'Server not found.' };
  Object.assign(meta, updates);
  writeMeta(slug, meta);
  return meta;
}

function deleteServer(slug) {
  const dir = serverDir(slug);
  if (!fs.existsSync(dir)) return { error: 'Server not found.' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// --- File Operations ---

function sanitizePath(filePath) {
  // Prevent path traversal
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  if (normalized.includes('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

function listFiles(slug) {
  const dir = serverDir(slug);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  function walk(currentDir, prefix) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'logs' || entry.name.startsWith('.')) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relPath);
      } else {
        results.push(relPath);
      }
    }
  }
  walk(dir, '');
  return results;
}

function readFile(slug, filePath) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(slug), safe);
  if (!fs.existsSync(full)) return { error: 'File not found.' };
  return { content: fs.readFileSync(full, 'utf8'), path: safe };
}

function writeFile(slug, filePath, content) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(slug), safe);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content);
  return { ok: true, path: safe };
}

function deleteFile(slug, filePath) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(slug), safe);
  if (!fs.existsSync(full)) return { error: 'File not found.' };
  fs.unlinkSync(full);
  return { ok: true };
}

// --- Dependencies ---

function listDeps(slug) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir(slug), 'package.json'), 'utf8'));
    return Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version, status: 'installed' }));
  } catch { return []; }
}

function installDep(slug, pkgName, version, onData, onDone) {
  const dir = serverDir(slug);
  const arg = version ? `${pkgName}@${version}` : pkgName;
  const proc = spawn('npm', ['install', arg], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

function uninstallDep(slug, pkgName, onData, onDone) {
  const dir = serverDir(slug);
  const proc = spawn('npm', ['uninstall', pkgName], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

function installAll(slug, onData, onDone) {
  const dir = serverDir(slug);
  const proc = spawn('npm', ['install'], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

module.exports = {
  getServersDir, serverDir, slugify, validateSlug,
  listServers, loadServer, createServer, updateServer, deleteServer,
  readMeta, writeMeta, writeDefaultFiles,
  listFiles, readFile, writeFile, deleteFile,
  listDeps, installDep, uninstallDep, installAll,
};
