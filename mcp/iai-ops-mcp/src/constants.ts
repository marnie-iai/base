export const BOARD_API_BASE = "https://api.integratedai.com.au";
export const IOPS_DEBRIEF_URL = "https://iops.integratedai.com.au/api/fenn/debrief";
export const AGENT_CONTEXT_BASE = "https://base.integratedai.com.au/api/agent-context";

/**
 * Known pursuit board codes -> URL path segment. "main" is the top-level
 * /sprint board (empty segment). This is a union of the code lists found in
 * grid-board-ops (io, eng, iv, pc, main) and open-session-iai (io, hif, hed,
 * pc, hma, ws, iv) — confirmed with Marnie to keep both rather than pick one,
 * since pursuit boards open and close over time. An unrecognised code is
 * still attempted by the board client (a 404 confirms it's genuinely wrong)
 * rather than hard-blocked here.
 */
export const PURSUITS: Record<string, string> = {
  main: "",
  io: "io",
  eng: "eng",
  iv: "iv",
  pc: "pc",
  hif: "hif",
  hed: "hed",
  hma: "hma",
  ws: "ws",
};

// Statuses that count as "closed" and are excluded from default board reads.
export const CLOSED_STATUSES = new Set([
  "complete",
  "dumpster",
  "dormant",
  "backlog",
  "superseded",
]);

// Maximum characters returned in a single tool response before truncation.
export const CHARACTER_LIMIT = 25000;

// Identity attached to board writes. The board is Alex-held, so this
// defaults to "alex" unless overridden per session or per call.
export const DEFAULT_AGENT = process.env.IAI_DEFAULT_AGENT || "alex";
