import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "{{slug}}",
  version: "1.0.0",
});

// Set BASE_URL in Environment Variables on the Setup tab
const BASE_URL = process.env.BASE_URL || "https://jsonplaceholder.typicode.com";

server.tool(
  "http_get",
  `Fetch JSON from a GET endpoint. Base URL: ${BASE_URL}`,
  {
    path: z.string().describe("URL path (e.g. /users or /posts/1)"),
    headers: z.record(z.string()).optional().describe("Extra request headers"),
  },
  async ({ path, headers }) => {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, { headers: { "Accept": "application/json", ...headers } });
    const body = await res.text();
    return {
      content: [{ type: "text", text: `${res.status} ${res.statusText}\n\n${body}` }],
    };
  }
);

server.tool(
  "http_post",
  `Send a POST request with JSON body. Base URL: ${BASE_URL}`,
  {
    path: z.string().describe("URL path"),
    body: z.record(z.any()).describe("JSON body to send"),
    headers: z.record(z.string()).optional().describe("Extra request headers"),
  },
  async ({ path, body, headers }) => {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      content: [{ type: "text", text: `${res.status} ${res.statusText}\n\n${text}` }],
    };
  }
);

export default server;
