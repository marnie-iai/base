/**
 * Fenn / iOps debrief client.
 *
 * POSTs a session-close debrief as a PENDING record only — this client never
 * logs hours, updates the Engage portal, or publishes anything itself. The
 * confirm-first gate lives one layer up (the calling tool's description and
 * the agent's own behaviour), matching the fenn-handover skill this ports.
 *
 * Specific status codes are surfaced with actionable messages because the
 * skill this replaces documents exactly what each one means:
 *   - 401: wrong IOPS_DEBRIEF_TOKEN
 *   - 503: endpoint has no token configured server-side
 *   - 409 / fenn_debriefs_migration_pending: migration 0049 hasn't run yet
 */
import axios from "axios";
import { IOPS_DEBRIEF_URL } from "../constants.js";
import { DebriefAction } from "../types.js";

export class DebriefApiError extends Error {}

export interface DebriefPayload {
  job: string;
  date?: string;
  hours: number;
  summary_internal: string;
  summary_client?: string;
  actions?: DebriefAction[];
}

/**
 * Sends one debrief payload to the iOps Fenn endpoint.
 *
 * @param payload - job, hours, summaries, and optional actions. Must already
 *   have been reviewed and approved by a human — this function does not
 *   gate on confirmation itself.
 * @returns the pending record's id and status on success (HTTP 201).
 * @throws {DebriefApiError} on any non-201 response or network failure, with
 *   a message that names the specific known cause where possible.
 */
export async function sendDebrief(payload: DebriefPayload): Promise<{ id: unknown; status: unknown }> {
  const token = process.env.IOPS_DEBRIEF_TOKEN;
  if (!token) {
    throw new DebriefApiError("IOPS_DEBRIEF_TOKEN is not set — cannot send a debrief without it.");
  }

  const body = { source: "strategist-session", ...payload };

  let res;
  try {
    res = await axios({
      method: "POST",
      url: IOPS_DEBRIEF_URL,
      data: body,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true,
    });
  } catch (err) {
    throw new DebriefApiError(`Network error reaching ${IOPS_DEBRIEF_URL}: ${(err as Error).message}`);
  }

  if (res.status === 201) {
    const data = res.data as { id?: unknown; status?: unknown };
    return { id: data.id, status: data.status };
  }
  if (res.status === 401) {
    throw new DebriefApiError("401 — the iOps debrief token is wrong. Check IOPS_DEBRIEF_TOKEN.");
  }
  if (res.status === 503) {
    throw new DebriefApiError("503 — the iOps debrief endpoint has no token configured server-side.");
  }
  const data = res.data as { error?: string } | undefined;
  if (res.status === 409 || data?.error === "fenn_debriefs_migration_pending") {
    throw new DebriefApiError(
      "409 fenn_debriefs_migration_pending — migration 0049 has not run yet. Nothing was lost; " +
        "keep this payload and resend once it has."
    );
  }
  throw new DebriefApiError(`HTTP ${res.status} sending debrief: ${JSON.stringify(res.data).slice(0, 300)}`);
}
