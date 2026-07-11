/**
 * Registers the eight board-domain tools on the MCP server. Each tool is a
 * thin wrapper: validate (Zod, via inputSchema), delegate to
 * services/boardClient.ts (or boardAuth.ts for login), format the result,
 * and translate any thrown error into an MCP `isError` result rather than
 * letting it propagate as a protocol-level failure — see errorResult below.
 *
 * All business logic (trap-handling, verify-after-write, id resolution)
 * lives in services/boardClient.ts, not here. This file's only job is the
 * MCP-facing shape: schema, description, annotations, response formatting.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReadBoardInput,
  GetCardInput,
  CreateCardInput,
  UpdateCardInput,
  VerifyCardInput,
  ListAgeingInput,
  BoardLoginInput,
} from "../schemas/board.js";
import * as board from "../services/boardClient.js";
import { login } from "../services/boardAuth.js";
import { formatCardsMarkdown, truncate } from "../format.js";
import { DEFAULT_AGENT } from "../constants.js";

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

export function registerBoardTools(server: McpServer): void {
  server.registerTool(
    "iai_list_boards",
    {
      title: "List IAI board codes",
      description:
        "Returns the known pursuit board codes and their endpoints on the IAI sprint board API. " +
        "Call this first if unsure which code to pass as 'board' to any other iai_* board tool. " +
        "Codes are abbreviated — 'io' not 'iops', 'eng' not 'engage'. This list is best-effort: a " +
        "new pursuit board can exist before it's added here, in which case the exact code from the " +
        "board's own URL will still work with iai_read_board.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const boards = board.knownBoards();
      const text = boards.map((b) => `- ${b.code}: ${b.endpoint}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { boards } };
    }
  );

  server.registerTool(
    "iai_read_board",
    {
      title: "Read an IAI sprint board",
      description:
        "Fetches cards from one board (main sprint board or a pursuit board) and filters by status/owner. " +
        "Filtering happens client-side after fetching the full board, because the API's own '?owner=' query " +
        "parameter is documented as unreliable. Excludes complete/backlog/dormant/superseded/dumpster cards " +
        "by default.\n\n" +
        "Args:\n" +
        "  - board (string): board code, e.g. 'io', 'eng', 'iv', 'pc', 'main'. Call iai_list_boards if unsure.\n" +
        "  - status (string, optional): exact status match, e.g. 'active', 'gate'.\n" +
        "  - owner (string, optional): case-insensitive exact owner match.\n" +
        "  - include_closed (boolean, default false): include closed-state cards.\n" +
        "  - response_format ('markdown' | 'json', default 'markdown').\n\n" +
        "Returns a table of cardId/status/priority/owner/title in markdown, or full card objects in JSON.",
      inputSchema: ReadBoardInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        let cards = await board.getBoard(params.board, params.include_closed);
        if (params.status) {
          cards = cards.filter((c) => String(c.status) === params.status);
        }
        if (params.owner) {
          const owner = params.owner.toLowerCase();
          cards = cards.filter((c) => String(c.owner).toLowerCase() === owner);
        }

        const output = { board: params.board, count: cards.length, cards };
        const text =
          params.response_format === "json" ? JSON.stringify(output, null, 2) : formatCardsMarkdown(params.board, cards);
        const { text: finalText } = truncate(text);
        return { content: [{ type: "text", text: finalText }], structuredContent: output };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_get_card",
    {
      title: "Get one IAI board card",
      description:
        "Fetches a single card by display cardId (e.g. 'IO-038') or numeric id (e.g. '38') from one board.\n\n" +
        "Args:\n  - board (string): board code.\n  - ref (string): cardId or numeric id.\n\n" +
        "Returns the full card object, or a not-found message.",
      inputSchema: GetCardInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const card = await board.getCard(params.board, params.ref);
        if (!card) {
          return { content: [{ type: "text", text: `No card '${params.ref}' found on board '${params.board}'.` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }], structuredContent: { card } };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_create_card",
    {
      title: "Create an IAI board card",
      description:
        "Creates a new card on the given board (POST). Returns the assigned display cardId and numeric id — " +
        "capture both; PATCH/verify calls need the numeric id.\n\n" +
        "Title rules: specific and searchable, no agent name, no status in the title. Context goes in " +
        "sessionNotes/description, not the title.\n\n" +
        "dependsOn accepts either display cardIds (e.g. 'IO-020') or numeric ids — both are resolved to an " +
        "integer array before the request is sent, since the API silently drops string cardIds.",
      inputSchema: CreateCardInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { board: pursuit, agent, ...fields } = params;
        const card = await board.postCard(pursuit, fields, agent ?? DEFAULT_AGENT);
        const cardId = (card as { cardId?: unknown }).cardId ?? "?";
        const id = (card as { id?: unknown }).id ?? "?";
        return {
          content: [{ type: "text", text: `Created ${cardId} (id ${id}) on board '${pursuit}'.` }],
          structuredContent: { card },
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_update_card",
    {
      title: "Update an IAI board card",
      description:
        "Patches a card (status, owner, priority, session notes, briefRef, referenceUrl, marnieAction, dependsOn) " +
        "and re-queries the board afterward to confirm the change actually stuck — the API can silently fail or " +
        "revert a write on DNS blips. Returns ok:false if the change did not verify; re-run in that case rather " +
        "than assuming it landed.\n\n" +
        "sessionNotes is append-only and the API auto-prepends its own timestamp — do NOT include a date prefix, " +
        "or the date will appear twice.\n\n" +
        "dependsOn accepts cardIds or numeric ids, resolved to integers automatically.",
      inputSchema: UpdateCardInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { board: pursuit, ref, agent, ...fields } = params;
        const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(cleanFields).length === 0) {
          return errorResult(new Error("Provide at least one field to change (status, owner, priority, sessionNotes, briefRef, referenceUrl, marnieAction, or dependsOn)."));
        }
        const verifyField = "status" in cleanFields ? "status" : Object.keys(cleanFields)[0];
        const { card, ok } = await board.patchCard(pursuit, ref, cleanFields, agent ?? DEFAULT_AGENT, verifyField);
        const text = ok
          ? `Updated ${ref} on '${pursuit}' — verified.`
          : `WARNING: write to ${ref} on '${pursuit}' did not verify. Re-run this update, or check the board manually.`;
        return { content: [{ type: "text", text }], structuredContent: { ok, card } };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_verify_card",
    {
      title: "Verify IAI board card fields",
      description:
        "Re-queries a card and confirms one or more fields match expected values. Use this to double-check a " +
        "write that previously came back ok:false from iai_update_card.\n\n" +
        "Args:\n  - board (string), ref (string): card to check.\n" +
        "  - expected (object): field/value pairs, e.g. { \"status\": \"review\" }.\n\n" +
        "Returns true only if every field matches exactly (string-compared).",
      inputSchema: VerifyCardInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const ok = await board.verifyCard(params.board, params.ref, params.expected);
        return { content: [{ type: "text", text: ok ? "true" : "false" }], structuredContent: { ok } };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_list_ageing_backlog",
    {
      title: "List ageing/backlog cards",
      description:
        "Fetches the ageing/backlog view used for Monday backlog review. This endpoint's exact response shape " +
        "has not yet been verified against the live API — treat the returned data as provisional until confirmed " +
        "on a real call.\n\nArgs:\n  - board (string, optional): restrict to one pursuit board. Omit for the main board.",
      inputSchema: ListAgeingInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data = await board.getAgeingBacklog(params.board);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { data } };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "iai_board_login",
    {
      title: "Sign in to the IAI board API",
      description:
        "Runs (or re-runs) the interactive Google sign-in for the IAI sprint board API. Opens a browser for " +
        "consent as marnie@integratedcoatingservices.com, then caches a refresh token locally so future sessions " +
        "don't need to repeat this. Call this proactively if any board tool returns a 401 or a 'not signed in' error.\n\n" +
        "Requires IAI_BOARD_OAUTH_CLIENT_ID (and usually IAI_BOARD_OAUTH_CLIENT_SECRET) to be set in the " +
        "environment first.",
      inputSchema: BoardLoginInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await login(params.force);
        const text = `Signed in${result.email ? ` as ${result.email}` : ""}. Token cached for future sessions.`;
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
