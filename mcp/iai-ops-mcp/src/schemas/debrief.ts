/**
 * Zod input schema for iai_send_fenn_debrief (src/tools/debrief.ts).
 *
 * `actions` is restricted to the six functions documented in the
 * fenn-handover skill's catalogue — this is deliberately a closed enum, not
 * an open string, so a typo'd or invented function name fails validation at
 * the schema boundary instead of reaching the live endpoint.
 */
import { z } from "zod";

const ActionFn = z.enum([
  "log_activity",
  "update_module_state",
  "update_milestone",
  "set_next_milestone",
  "update_questionnaire_status",
  "publish_deliverable",
]);

const ActionSchema = z.object({ fn: ActionFn }).catchall(z.unknown());

export const SendFennDebriefInput = z
  .object({
    job: z.string().min(1).describe("The iOps job this session was for, as named on the Jobs board, e.g. 'Hedweld strategy'."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO YYYY-MM-DD")
      .optional()
      .describe("ISO YYYY-MM-DD, AEST. Omit for today."),
    hours: z.number().min(0).max(24).describe("Decimal hours spent this session. Never inflate."),
    summary_internal: z.string().min(1).describe("Full detail, internal only. Plain text, no markdown headings."),
    summary_client: z
      .string()
      .optional()
      .describe(
        "Client-safe version for the Engage portal. Omit entirely if nothing is client-visible — never a watered-down internal summary."
      ),
    actions: z
      .array(ActionSchema)
      .optional()
      .describe("Only requests for work genuinely completed this session, from the six documented functions."),
  })
  .strict();
