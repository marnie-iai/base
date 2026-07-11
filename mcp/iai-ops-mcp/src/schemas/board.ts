/**
 * Zod input schemas for every iai_* board tool (src/tools/board.ts). Each
 * schema is `.strict()` so unexpected fields are rejected at the boundary
 * rather than silently ignored, and every field carries a `.describe()`
 * where its meaning isn't obvious from the name alone — these descriptions
 * flow straight into the generated JSON Schema an MCP client sees.
 *
 * `.shape` (not the ZodObject itself) is what gets passed to
 * `server.registerTool`'s `inputSchema` option — see any tools/*.ts file.
 */
import { z } from "zod";

export const ResponseFormat = z.enum(["markdown", "json"]).default("markdown");

const PriorityEnum = z.enum(["must", "should", "could"]);

export const ReadBoardInput = z
  .object({
    board: z
      .string()
      .min(1)
      .describe(
        "Board code, e.g. 'io', 'eng', 'iv', 'pc', 'main', 'hif', 'hed', 'hma', 'ws'. Call iai_list_boards if unsure."
      ),
    status: z
      .string()
      .optional()
      .describe("Filter to a single exact status, e.g. 'active', 'gate'. Applied client-side."),
    owner: z
      .string()
      .optional()
      .describe(
        "Filter to a single owner, case-insensitive. Applied client-side — the API's own ?owner= filter is documented as unreliable."
      ),
    include_closed: z
      .boolean()
      .default(false)
      .describe("Include complete/backlog/dormant/superseded/dumpster cards. Default false."),
    response_format: ResponseFormat,
  })
  .strict();

export const GetCardInput = z
  .object({
    board: z.string().min(1),
    ref: z.string().min(1).describe("Card reference: display cardId (e.g. 'IO-038') or numeric id (e.g. '38')."),
  })
  .strict();

export const CreateCardInput = z
  .object({
    board: z.string().min(1),
    title: z.string().min(1).describe("Specific and searchable. No agent name, no status in the title."),
    description: z.string().min(1),
    owner: z.string().min(1),
    domain: z.string().min(1),
    status: z.string().min(1).describe("e.g. 'backlog', 'active', 'gate'."),
    priority: PriorityEnum.optional(),
    dependsOn: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .describe("cardIds (e.g. 'IO-020') or numeric ids — resolved to integers automatically."),
    briefRef: z.string().optional(),
    referenceUrl: z.string().optional(),
    filedPath: z.string().optional(),
    outputPath: z.string().optional(),
    marnieAction: z.string().optional(),
    sessionNotes: z
      .string()
      .optional()
      .describe("Plain text only — do NOT prefix with a date, the API auto-timestamps notes."),
    agent: z.string().optional().describe("Defaults to the configured agent identity (usually 'alex')."),
  })
  .strict();

export const UpdateCardInput = z
  .object({
    board: z.string().min(1),
    ref: z.string().min(1),
    status: z.string().optional(),
    owner: z.string().optional(),
    priority: PriorityEnum.optional(),
    sessionNotes: z
      .string()
      .optional()
      .describe(
        "Plain text only — do NOT prefix with a date. The API auto-timestamps notes and appends rather than replaces."
      ),
    briefRef: z.string().optional(),
    referenceUrl: z.string().optional(),
    marnieAction: z.string().optional(),
    dependsOn: z.array(z.union([z.string(), z.number()])).optional(),
    agent: z.string().optional(),
  })
  .strict();

export const VerifyCardInput = z
  .object({
    board: z.string().min(1),
    ref: z.string().min(1),
    expected: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe("Field/value pairs to confirm, e.g. { status: 'review' }."),
  })
  .strict();

export const ListAgeingInput = z
  .object({
    board: z.string().optional().describe("Restrict to one pursuit board's ageing view. Omit for the main board."),
  })
  .strict();

export const BoardLoginInput = z
  .object({
    force: z.boolean().default(false).describe("Re-run the interactive Google sign-in even if a cached session exists."),
  })
  .strict();
