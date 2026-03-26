import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "{{slug}}",
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
      content: [{ type: "text", text: `Hello, ${name}!` }],
    };
  }
);

export default server;
