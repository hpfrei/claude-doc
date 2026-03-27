#!/usr/bin/env node
// MCP Bridge — stdio runner for MCP servers managed by the dashboard.
// Claude Code spawns this: node lib/mcp-bridge.js <slug>
// It imports the server module and connects it via StdioServerTransport.
//
// The SDK is resolved from the server's own node_modules (not the dashboard's).

import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slug = process.argv[2] || process.env.CLAUDE_DOC_SERVER_SLUG;
if (!slug) {
  process.stderr.write("Usage: mcp-bridge.js <slug>\n");
  process.exit(1);
}

const serverDir = path.join(__dirname, "..", "mcp-servers", slug);

async function main() {
  // Resolve the SDK from the server's own node_modules
  const serverRequire = createRequire(path.join(serverDir, "package.json"));
  const stdioPath = serverRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const { StdioServerTransport } = await import(pathToFileURL(stdioPath).href);

  // Dynamic import of the user's server module (ESM)
  const mod = await import(pathToFileURL(path.join(serverDir, "server.js")).href);
  const server = mod.default;

  if (!server || typeof server.connect !== "function") {
    process.stderr.write(`Error: server.js must export default an McpServer instance\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP bridge error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
