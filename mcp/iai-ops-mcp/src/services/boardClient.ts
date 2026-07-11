/**
 * Board API client. Ports every trap-handling behaviour documented and
 * exercised in grid.py (the existing, proven Python helper) rather than
 * reinventing it:
 *   - abbreviated, board-specific pursuit codes
 *   - PATCH by numeric id only, never the display cardId
 *   - dependsOn resolved from cardIds to integers
 *   - sessionNotes is append-only server-side, never date-prefixed here
 *   - every write is re-queried and confirmed before returning ok:true
 *   - board responses parsed for both 'cards' and 'tasks' keys
 */
import axios from "axios";
import { BOARD_API_BASE, PURSUITS, CLOSED_STATUSES } from "../constants.js";
import { Card } from "../types.js";
import { getAccessToken } from "./boardAuth.js";

export class BoardApiError extends Error {}

function endpoint(pursuit: string, suffix = ""): string {
  if (!(pursuit in PURSUITS)) {
    const known = Object.keys(PURSUITS).join(", ");
    throw new BoardApiError(
      `Unrecognised board code '${pursuit}'. Known codes: ${known}. Codes are abbreviated ` +
        `(use 'io' not 'iops', 'eng' not 'engage'). If this is a genuinely new pursuit board ` +
        `not yet in this list, retry with the exact code from the board's own URL — it may still work.`
    );
  }
  const code = PURSUITS[pursuit];
  const base = code ? `${BOARD_API_BASE}/${code}/sprint` : `${BOARD_API_BASE}/sprint`;
  return base + suffix;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    throw new BoardApiError(
      `Not signed in to the board API. Run iai_board_login first. (${(err as Error).message})`
    );
  }

  let res;
  try {
    res = await axios({
      method,
      url,
      data: body,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true,
    });
  } catch (err) {
    throw new BoardApiError(`Network error reaching ${url}: ${(err as Error).message}. Retry — DNS blips happen.`);
  }

  if (res.status === 404) {
    throw new BoardApiError(
      `404 from ${url} — likely a wrong board code or a route that doesn't accept ${method}. ` +
        `${JSON.stringify(res.data).slice(0, 300)}`
    );
  }
  if (res.status === 401) {
    throw new BoardApiError(`401 from ${url} — the Google session may have expired. Run iai_board_login to re-authenticate.`);
  }
  if (res.status >= 400) {
    throw new BoardApiError(`HTTP ${res.status} from ${url}: ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  return res.data as T;
}

function cardsFrom(payload: unknown): Card[] {
  if (Array.isArray(payload)) return payload as Card[];
  const obj = payload as { cards?: Card[]; tasks?: Card[] } | undefined;
  return obj?.cards ?? obj?.tasks ?? [];
}

export async function getBoard(pursuit: string, includeClosed = false): Promise<Card[]> {
  const cards = cardsFrom(await request("GET", endpoint(pursuit)));
  if (includeClosed) return cards;
  return cards.filter((c) => !CLOSED_STATUSES.has(String(c.status)));
}

async function indexBoard(pursuit: string): Promise<Map<string, Card>> {
  const cards = cardsFrom(await request("GET", endpoint(pursuit)));
  const idx = new Map<string, Card>();
  for (const c of cards) {
    if (c.cardId !== undefined) idx.set(String(c.cardId), c);
    if (c.id !== undefined) idx.set(String(c.id), c);
  }
  return idx;
}

export async function resolveId(pursuit: string, ref: string | number): Promise<number> {
  if (typeof ref === "number") return ref;
  if (/^\d+$/.test(ref)) return parseInt(ref, 10);
  const idx = await indexBoard(pursuit);
  const card = idx.get(ref);
  if (!card || card.id === undefined) {
    throw new BoardApiError(`Could not resolve '${ref}' to a numeric id on board '${pursuit}'.`);
  }
  return Number(card.id);
}

export async function getCard(pursuit: string, ref: string | number): Promise<Card | undefined> {
  const idx = await indexBoard(pursuit);
  const direct = idx.get(String(ref));
  if (direct) return direct;
  const numId = await resolveId(pursuit, ref);
  return idx.get(String(numId));
}

async function toIntIds(pursuit: string, items: (string | number)[]): Promise<number[]> {
  const out: number[] = [];
  for (const item of items) {
    out.push(typeof item === "number" ? item : await resolveId(pursuit, item));
  }
  return out;
}

export interface WritableFields {
  title?: string;
  description?: string;
  owner?: string;
  domain?: string;
  status?: string;
  priority?: string;
  sessionNotes?: string;
  briefRef?: string;
  referenceUrl?: string;
  filedPath?: string;
  outputPath?: string;
  marnieAction?: string;
  dependsOn?: (string | number)[];
}

export async function patchCard(
  pursuit: string,
  ref: string | number,
  fields: WritableFields,
  agent: string,
  verifyField: string | null
): Promise<{ card: unknown; ok: boolean }> {
  const numId = await resolveId(pursuit, ref);
  const body: Record<string, unknown> = { agent, ...fields };
  if (fields.dependsOn) {
    body.dependsOn = await toIntIds(pursuit, fields.dependsOn);
  }

  const resp = await request<unknown>("PATCH", endpoint(pursuit, `/${numId}`), body);

  let ok = true;
  if (verifyField && verifyField in body) {
    await new Promise((r) => setTimeout(r, 600));
    const fresh = await getCard(pursuit, numId);
    ok = String((fresh as Record<string, unknown> | undefined)?.[verifyField]) === String(body[verifyField]);
  }
  return { card: resp, ok };
}

export interface CreateFields {
  title: string;
  description: string;
  owner: string;
  domain: string;
  status: string;
  priority?: string;
  dependsOn?: (string | number)[];
  briefRef?: string;
  referenceUrl?: string;
  filedPath?: string;
  outputPath?: string;
  marnieAction?: string;
  sessionNotes?: string;
}

export async function postCard(pursuit: string, fields: CreateFields, agent: string): Promise<Card> {
  const body: Record<string, unknown> = { agent, ...fields };
  if (fields.dependsOn) {
    body.dependsOn = await toIntIds(pursuit, fields.dependsOn);
  }
  return request<Card>("POST", endpoint(pursuit), body);
}

export async function verifyCard(
  pursuit: string,
  ref: string | number,
  expected: Record<string, unknown>
): Promise<boolean> {
  const fresh = (await getCard(pursuit, ref)) ?? {};
  return Object.entries(expected).every(([k, v]) => String((fresh as Record<string, unknown>)[k]) === String(v));
}

export async function getAgeingBacklog(pursuit?: string): Promise<unknown> {
  const url = pursuit ? endpoint(pursuit, "/ageing") : `${BOARD_API_BASE}/sprint/ageing`;
  return request<unknown>("GET", url);
}

export function knownBoards(): { code: string; endpoint: string }[] {
  return Object.entries(PURSUITS).map(([code, seg]) => ({
    code,
    endpoint: seg ? `${BOARD_API_BASE}/${seg}/sprint` : `${BOARD_API_BASE}/sprint`,
  }));
}
