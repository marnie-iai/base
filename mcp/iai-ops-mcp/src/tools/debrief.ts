/**
 * Registers iai_send_fenn_debrief. All confirm-first and client-safe-summary
 * discipline is documented in the tool description itself (an MCP client
 * only sees the description, never this source file) — see
 * services/debriefClient.ts for the actual HTTP call and error mapping.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SendFennDebriefInput } from "../schemas/debrief.js";
import { sendDebrief } from "../services/debriefClient.js";

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

export function registerDebriefTools(server: McpServer): void {
  server.registerTool(
    "iai_send_fenn_debrief",
    {
      title: "Send a session debrief to Fenn (iOps)",
      description:
        "Posts a strategist session's debrief to Fenn in iOps as a PENDING record. This does NOT log hours, " +
        "update the Engage portal, or publish anything by itself — Fenn walks a human through confirming each " +
        "effect afterward.\n\n" +
        "IMPORTANT: only call this after the human has explicitly reviewed and approved the payload (job, hours, " +
        "both summaries, and any actions) shown to them in plain language. This tool cannot enforce that " +
        "confirmation itself.\n\n" +
        "The internal/client summary split is a hard boundary: summary_client must never include internal money, " +
        "margins, utilisation, hours-vs-estimate framing, other clients, or internal risk notes. If nothing about " +
        "the session is client-visible, omit summary_client entirely rather than watering down the internal one.\n\n" +
        "'actions' may only use these six functions: log_activity, update_module_state, update_milestone, " +
        "set_next_milestone, update_questionnaire_status, publish_deliverable — and only for work genuinely " +
        "completed this session.\n\n" +
        "On success returns the pending record's id. Known errors: 401 = wrong token; 503 = token not configured " +
        "server-side; 409 fenn_debriefs_migration_pending = migration 0049 hasn't run yet (nothing is lost — the " +
        "payload can be resent later).",
      inputSchema: SendFennDebriefInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await sendDebrief(params);
        const text = `Debrief sent — pending id ${String(result.id)}, status ${String(
          result.status
        )}. Fenn will walk the confirm through in iOps.`;
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
