#!/usr/bin/env node
// MCP Bridge — stdio runner for MCP servers managed by the dashboard.
// Claude Code spawns this: node lib/mcp-bridge.js <slug>
// It imports the server module and connects it via StdioServerTransport.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const slug = process.argv[2] || process.env.CLAUDE_DOC_SERVER_SLUG;
if (!slug) {
  process.stderr.write("Usage: mcp-bridge.js <slug>\n");
  process.exit(1);
}

const serverDir = path.join(__dirname, "..", "mcp-servers", slug);
const serverPath = path.join(serverDir, "server.js");

// Resolve the SDK from the server's own node_modules
const sdkBase = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk");

async function main() {
  // Dynamic import of the user's server module (ESM)
  const mod = await import(serverPath);
  const server = mod.default;

  if (!server || typeof server.connect !== "function") {
    process.stderr.write(`Error: ${serverPath} must export default an McpServer instance\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP bridge error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
