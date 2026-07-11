#!/usr/bin/env node
/**
 * iai-ops-mcp — MCP server wrapping three IAI-internal APIs:
 *   - the sprint board (api.integratedai.com.au), read/create/update/verify
 *   - the Fenn iOps session-close debrief endpoint
 *   - the DEV-010 agent context store (experimental, may not be live)
 *
 * Ports the trap-handling proven in grid-board-ops's grid.py and the
 * confirm-first, client-safe-summary discipline in fenn-handover — see
 * IAI_MCP_Server_Plan.md for the full design and open questions.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBoardTools } from "./tools/board.js";
import { registerDebriefTools } from "./tools/debrief.js";
import { registerContextTools } from "./tools/context.js";

const server = new McpServer({
  name: "iai-ops-mcp",
  version: "0.1.0",
});

registerBoardTools(server);
registerDebriefTools(server);
registerContextTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iai-ops-mcp running via stdio");
}

main().catch((err) => {
  console.error("Fatal error starting iai-ops-mcp:", err);
  process.exit(1);
});
