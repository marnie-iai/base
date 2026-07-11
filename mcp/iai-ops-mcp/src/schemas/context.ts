/**
 * Zod input schemas for the two experimental agent-context tools
 * (src/tools/context.ts). Kept intentionally close to the context_json
 * shape documented in close-session-iai's Step 7 POST example, since
 * DEV-010 isn't live yet and there's no real response to validate against.
 */
import { z } from "zod";

export const GetAgentContextInput = z
  .object({
    agent_id: z.string().min(1).describe("Lowercase agent slug, e.g. 'reid', 'morgan', 'harlow'."),
    limit: z.number().int().min(1).max(20).default(3),
  })
  .strict();

export const PostAgentContextInput = z
  .object({
    agent: z.string().min(1),
    session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO YYYY-MM-DD"),
    week: z.string().optional().describe("e.g. '2026-W28'."),
    work_completed: z.array(z.string()).default([]),
    decisions_made: z.array(z.string()).default([]),
    open_items: z
      .array(
        z.object({
          card_id: z.number(),
          title: z.string(),
          status: z.string(),
          next_action: z.string(),
        })
      )
      .default([]),
    flags: z.array(z.string()).default([]),
    carry_forward: z.string().optional(),
  })
  .strict();
