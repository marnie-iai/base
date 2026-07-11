/**
 * Agent context store (DEV-010). Reported not-live as of this build, so
 * every call here degrades gracefully — unreachable, unconfigured, or
 * erroring all resolve to available:false / ok:false with a note, never a
 * thrown error, matching the "don't block the session" instruction in the
 * open-session-iai and close-session-iai skills.
 */
import axios from "axios";
import { AGENT_CONTEXT_BASE } from "../constants.js";

export interface AgentContextEntry {
  agent: string;
  session_date: string;
  context_json: Record<string, unknown>;
}

function authHeader(): Record<string, string> | null {
  const key = process.env.AGENT_API_KEY;
  if (!key) return null;
  return { Authorization: `Bearer ${key}` };
}

export async function getAgentContext(
  agentId: string,
  limit: number
): Promise<{ available: boolean; records: unknown[]; note?: string }> {
  const headers = authHeader();
  if (!headers) {
    return { available: false, records: [], note: "AGENT_API_KEY not set — agent context store not configured." };
  }
  try {
    const res = await axios.get(`${AGENT_CONTEXT_BASE}/${encodeURIComponent(agentId)}`, {
      params: { limit },
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      const data = res.data as { records?: unknown[] } | undefined;
      return { available: true, records: data?.records ?? [] };
    }
    return {
      available: false,
      records: [],
      note: `Agent context store returned ${res.status} — treating as not live yet (DEV-010). Proceeding without it.`,
    };
  } catch (err) {
    return {
      available: false,
      records: [],
      note: `Agent context store unreachable — treating as not live yet (DEV-010). ${(err as Error).message}`,
    };
  }
}

export async function postAgentContext(entry: AgentContextEntry): Promise<{ ok: boolean; note?: string }> {
  const headers = authHeader();
  if (!headers) {
    return { ok: false, note: "AGENT_API_KEY not set — agent context store not configured." };
  }
  try {
    const res = await axios.post(AGENT_CONTEXT_BASE, entry, {
      headers: { ...headers, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true };
    }
    return { ok: false, note: `Agent context store returned ${res.status} — not blocking, continuing.` };
  } catch (err) {
    return { ok: false, note: `Agent context store unreachable — not blocking. ${(err as Error).message}` };
  }
}
