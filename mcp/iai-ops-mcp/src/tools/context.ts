/**
 * Registers the two experimental agent-context tools. Deliberately has no
 * try/catch here, unlike board.ts/debrief.ts — services/contextClient.ts
 * already swallows every failure mode itself (unset key, unreachable,
 * non-2xx) and returns available:false / ok:false with a note instead of
 * throwing, so these tools never error the calling session on DEV-010 being
 * unavailable.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetAgentContextInput, PostAgentContextInput } from "../schemas/context.js";
import { getAgentContext, postAgentContext } from "../services/contextClient.js";

export function registerContextTools(server: McpServer): void {
  server.registerTool(
    "iai_get_agent_context",
    {
      title: "Get agent context (experimental — DEV-010)",
      description:
        "EXPERIMENTAL: reads the last N structured context records for an agent from the DEV-010 agent context " +
        "store. As of this build, DEV-010 was reported not yet live — this tool degrades gracefully " +
        "(available:false with a note) rather than erroring if the store is unreachable or unconfigured. Never " +
        "blocks a session on failure; merge with any session intel found elsewhere rather than treating this as " +
        "the sole source.",
      inputSchema: GetAgentContextInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const result = await getAgentContext(params.agent_id, params.limit);
      const text = result.available ? JSON.stringify(result.records, null, 2) : result.note ?? "Agent context store not available.";
      return { content: [{ type: "text", text }], structuredContent: result };
    }
  );

  server.registerTool(
    "iai_post_agent_context",
    {
      title: "Post agent context (experimental — DEV-010)",
      description:
        "EXPERIMENTAL: writes a structured session context summary for an agent to the DEV-010 agent context " +
        "store. As of this build, DEV-010 was reported not yet live — this tool degrades gracefully (ok:false " +
        "with a note) rather than erroring if the store is unreachable or unconfigured. Never blocks a session " +
        "close on failure.",
      inputSchema: PostAgentContextInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const { agent, session_date, ...contextFields } = params;
      const result = await postAgentContext({ agent, session_date, context_json: contextFields });
      const text = result.ok ? "Context written to store." : result.note ?? "Not written.";
      return { content: [{ type: "text", text }], structuredContent: result };
    }
  );
}
