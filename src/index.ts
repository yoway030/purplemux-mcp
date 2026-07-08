#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerAll } from "./tools.js";
import { SERVER_INSTRUCTIONS } from "./guide.js";

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "purplemux-mcp",
      version: "0.1.0",
    },
    // Surfaced to every connected client at initialize time — the tool
    // layering + golden path live here so orchestrators pick the agent
    // layer before ever reading individual tool descriptions.
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerAll(server);

  // stdio transport: both Claude Code and Codex launch stdio MCP servers.
  // No port/token dependency at startup — config is resolved per call.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Fatal bootstrap error only (per-call errors are handled inside tools).
  process.stderr.write(
    `purplemux-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
