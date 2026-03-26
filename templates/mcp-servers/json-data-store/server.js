import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const server = new McpServer({
  name: "{{slug}}",
  version: "1.0.0",
});

const STORE_FILE = join(process.cwd(), "store.json");

function loadStore() {
  if (!existsSync(STORE_FILE)) return {};
  try { return JSON.parse(readFileSync(STORE_FILE, "utf8")); } catch { return {}; }
}

function saveStore(data) {
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

server.tool("kv_get", "Get a value by key", {
  key: z.string().describe("The key to look up"),
}, async ({ key }) => {
  const store = loadStore();
  const val = store[key];
  return {
    content: [{ type: "text", text: val !== undefined ? JSON.stringify(val, null, 2) : `Key "${key}" not found.` }],
  };
});

server.tool("kv_set", "Set a key-value pair", {
  key: z.string().describe("The key to set"),
  value: z.string().describe("The value (stored as-is, use JSON strings for objects)"),
}, async ({ key, value }) => {
  const store = loadStore();
  let parsed;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  store[key] = parsed;
  saveStore(store);
  return { content: [{ type: "text", text: `Set "${key}" successfully.` }] };
});

server.tool("kv_delete", "Delete a key", {
  key: z.string().describe("The key to delete"),
}, async ({ key }) => {
  const store = loadStore();
  if (!(key in store)) return { content: [{ type: "text", text: `Key "${key}" not found.` }] };
  delete store[key];
  saveStore(store);
  return { content: [{ type: "text", text: `Deleted "${key}".` }] };
});

server.tool("kv_list", "List all keys in the store", {}, async () => {
  const store = loadStore();
  const keys = Object.keys(store);
  return {
    content: [{ type: "text", text: keys.length ? keys.join("\n") : "(empty store)" }],
  };
});

export default server;
