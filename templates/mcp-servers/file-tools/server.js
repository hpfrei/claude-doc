import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const server = new McpServer({
  name: "{{slug}}",
  version: "1.0.0",
});

// Set ROOT_DIR in Environment Variables on the Setup tab
const ROOT_DIR = resolve(process.env.ROOT_DIR || process.cwd());

function safePath(userPath) {
  const full = resolve(ROOT_DIR, userPath);
  if (!full.startsWith(ROOT_DIR)) throw new Error("Path outside root directory");
  return full;
}

server.tool("read_file", "Read the contents of a file", {
  path: z.string().describe("Relative path from ROOT_DIR"),
}, async ({ path }) => {
  const full = safePath(path);
  if (!existsSync(full)) return { content: [{ type: "text", text: `File not found: ${path}` }] };
  const content = readFileSync(full, "utf8");
  return { content: [{ type: "text", text: content }] };
});

server.tool("write_file", "Write content to a file (creates or overwrites)", {
  path: z.string().describe("Relative path from ROOT_DIR"),
  content: z.string().describe("Content to write"),
}, async ({ path, content }) => {
  const full = safePath(path);
  writeFileSync(full, content);
  return { content: [{ type: "text", text: `Written ${content.length} bytes to ${path}` }] };
});

server.tool("list_files", "List files in a directory", {
  path: z.string().optional().describe("Relative path (default: root)"),
}, async ({ path: dir }) => {
  const full = safePath(dir || ".");
  if (!existsSync(full)) return { content: [{ type: "text", text: `Directory not found: ${dir}` }] };
  const entries = readdirSync(full, { withFileTypes: true });
  const lines = entries.map(e => {
    const rel = relative(ROOT_DIR, join(full, e.name));
    return `${e.isDirectory() ? "📁" : "📄"} ${rel}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
});

server.tool("search_files", "Search for files containing a text pattern", {
  pattern: z.string().describe("Text to search for (case-insensitive)"),
  path: z.string().optional().describe("Subdirectory to search (default: root)"),
}, async ({ pattern, path: dir }) => {
  const root = safePath(dir || ".");
  const results = [];
  const lc = pattern.toLowerCase();

  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const content = readFileSync(full, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lc)) {
            results.push(`${relative(ROOT_DIR, full)}:${i + 1}: ${lines[i].trim()}`);
            if (results.length >= 50) return;
          }
        }
      } catch {}
    }
  }
  walk(root);
  return { content: [{ type: "text", text: results.join("\n") || "No matches found." }] };
});

export default server;
