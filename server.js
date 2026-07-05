'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 8080;
const GITHUB_PAT      = process.env.GITHUB_PAT;
const SITE_AUTH       = process.env.SITE_AUTH;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Google OAuth (site-wide sign-in) ─────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET       = process.env.SESSION_SECRET;
const OAUTH_REDIRECT_URI   = process.env.OAUTH_REDIRECT_URI || 'https://base.integratedai.com.au/auth/callback';
const ALLOWED_EMAILS       = (process.env.ALLOWED_EMAILS || 'marnie@integratedcoatingservices.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const GOOGLE_AUTH_ENABLED  = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && SESSION_SECRET);

if (!GOOGLE_AUTH_ENABLED) {
  console.warn('[auth] Google OAuth not fully configured — falling back to SITE_AUTH basic auth');
}
const KB_REPO = 'marnie-iai/kb';
const PORTRAITS_REPO = 'marnie-iai/agent-portraits';
const PORTRAITS_RAW = `https://raw.githubusercontent.com/${PORTRAITS_REPO}/main/portraits/`;
const ROSTER_FILE = 'kb/00-foundations/00_Agent_Roster_v2_2_Apr2026.md';
const GRID_API    = 'https://api.integratedai.com.au';

// ── Turso / Agent Context config ──────────────────────────────────────────────
const TURSO_URL        = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const AGENT_API_KEY    = process.env.AGENT_API_KEY;

const turso = (TURSO_URL && TURSO_AUTH_TOKEN)
  ? createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN })
  : null;

if (!turso) console.warn('[turso] TURSO_URL or TURSO_AUTH_TOKEN not set — agent context endpoints disabled');

// ── Index / Sheets config ──────────────────────────────────────────────────────
const SHEETS_API_KEY        = process.env.SHEETS_API_KEY;
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const SHEETS_SECTOR_COL     = 0;

// ── Site-wide Basic Auth (fallback when Google OAuth env vars aren't set) ────
function requireBasicAuth(req, res, next) {
  if (!SITE_AUTH) {
    console.warn('[site] SITE_AUTH not set — site is unprotected');
    return next();
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Integrated AI Base"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
  if (pass !== SITE_AUTH) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Integrated AI Base"');
    return res.status(401).send('Incorrect credentials');
  }
  next();
}

// ── Google OAuth site auth ────────────────────────────────────────────────────
function isAllowedEmail(email) {
  if (!email) return false;
  return ALLOWED_EMAILS.includes(String(email).toLowerCase());
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

function requireSiteAuth(req, res, next) {
  if (!GOOGLE_AUTH_ENABLED) return requireBasicAuth(req, res, next);
  const email = req.session && req.session.email;
  if (email && isAllowedEmail(email)) return next();
  const accept = String(req.headers.accept || '');
  if (req.method === 'GET' && accept.includes('text/html')) {
    return res.redirect('/auth/login?returnTo=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'unauthorized' });
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const TTL_5M  =  5 * 60 * 1000;
const TTL_10M = 10 * 60 * 1000;
const TTL_60M = 60 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttl = TTL_5M) {
  cache.set(key, { data, ts: Date.now(), ttl });
}

// ── Turso init ────────────────────────────────────────────────────────────────
async function initAgentContextTable() {
  if (!turso) return;
  try {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS agent_context (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id     TEXT    NOT NULL,
        session_date TEXT    NOT NULL,
        context_json TEXT    NOT NULL,
        created_at   TEXT    DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_agent_context_agent
      ON agent_context(agent_id, session_date DESC)
    `);
    console.log('[turso] agent_context table ready');
  } catch (err) {
    console.error('[turso] Failed to init agent_context table:', err.message);
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function ghFetch(url, auth = true) {
  const headers = { 'User-Agent': 'IAI-Base/3.0', 'Accept': 'application/vnd.github.v3+json' };
  if (auth && GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  const res = await fetch(url, { headers });
  if (!res.ok) { console.error(`[ghFetch] ${res.status} ${res.statusText} — ${url}`); return null; }
  return res.json();
}

async function fetchKBDir(kbPath) {
  const key = `kb:${kbPath}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    // Encode each segment separately so spaces become %20 but slashes stay intact
    const encoded = kbPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const data = await ghFetch(`https://api.github.com/repos/${KB_REPO}/contents/${encoded}`, true);
    const result = Array.isArray(data) ? data.filter(f => f.type === 'file') : [];
    cacheSet(key, result);
    return result;
  } catch { return []; }
}

async function fetchRawText(kbPath) {
  try {
    const encoded = kbPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `https://raw.githubusercontent.com/${KB_REPO}/main/${encoded}`;
    const headers = { 'User-Agent': 'IAI-Base/3.0' };
    if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return r.text();
  } catch { return null; }
}

async function searchKB(query) {
  const key = `search:${query.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${KB_REPO}&per_page=50`;
    const data = await ghFetch(url, true);
    const result = (data && data.items) ? data.items : [];
    cacheSet(key, result);
    return result;
  } catch { return []; }
}

// ── Roster parser ─────────────────────────────────────────────────────────────
function parseRoster(text) {
  const POINT_BY_CHIEF = {
    reid: 'business', sable: 'workshop', neve: 'family',
    maren: 'ikigai', sterling: 'resource',
  };
  const SKIP_H2 = ['five point', 'agents not', 'retired', 'structural', 'naming', 'prompt doc', 'portrait'];

  function slug(name) {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
  }
  function normalizeStatus(s) {
    if (!s) return 'live';
    const l = s.toLowerCase().trim();
    if (l.startsWith('live'))    return 'live';
    if (l.startsWith('active'))  return 'active';
    if (l.startsWith('planned')) return 'planned';
    return 'active';
  }

  const agents = [];
  const lines = text.split('\n');
  let currentPoint = 'foundations';
  let currentChiefSlug = 'arna';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('## ')) {
      const h2 = line.slice(3).trim();
      const lh2 = h2.toLowerCase();
      if (lh2.startsWith('marnie') || SKIP_H2.some(s => lh2.startsWith(s))) continue;

      let name, role;
      const chiefMatch = h2.match(/^Chief of (\w+)\s*[—-]\s*(\w+)/i);
      if (chiefMatch) {
        name = chiefMatch[2]; role = `Chief of ${chiefMatch[1]}`;
      } else {
        const parts = h2.split(/\s*[—-]\s*/);
        if (parts.length >= 2) { name = parts[0].trim(); role = parts.slice(1).join(' — ').trim(); }
      }
      if (!name) continue;

      const s = slug(name);
      if (POINT_BY_CHIEF[s]) { currentPoint = POINT_BY_CHIEF[s]; currentChiefSlug = s; }
      else if (s === 'arna')  { currentPoint = 'foundations'; currentChiefSlug = 'arna'; }

      let status = 'live', reportsTo = s === 'arna' ? null : 'arna', description = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const ml = lines[j].trim();
        if (!ml || ml.startsWith('##') || ml.startsWith('|')) break;
        if (ml.startsWith('*') || ml === '---') continue;
        const sm = ml.match(/Status:\s*([^|]+)/i);
        if (sm) status = normalizeStatus(sm[1]);
        const rm = ml.match(/Reports to:\s*(\w+)/i);
        if (rm) reportsTo = slug(rm[1]);
        if (!description && !ml.match(/^(Model|Status|Reports|Platform|Portrait|Note):/i)) {
          description = ml;
        }
      }
      agents.push({ name, slug: s, role, point: currentPoint, status, reportsTo, description: description.slice(0, 150), isChief: true });
      continue;
    }

    if (line.startsWith('|') && !line.includes(':---')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (!cells.length) continue;
      const name = cells[0];
      if (!name || /^(name|agent)$/i.test(name)) continue;
      const role = cells[1] || '';
      const statusCell = cells[4] || '';
      const notes = cells[5] || '';
      const s = slug(name);
      const status = normalizeStatus(statusCell);
      let reportsTo = currentChiefSlug;
      const rm = notes.match(/Reports to (\w+)/i);
      if (rm) reportsTo = slug(rm[1]);
      const description = notes.replace(/Reports to \w+\.?\s*/i, '').slice(0, 150);
      agents.push({ name, slug: s, role, point: currentPoint, status, reportsTo, description, isChief: false });
    }
  }
  return agents;
}

// ── Roster cache ──────────────────────────────────────────────────────────────
async function getRoster() {
  const key = 'roster';
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const text = await fetchRawText(ROSTER_FILE);
    if (!text) return [];
    const agents = parseRoster(text);
    cacheSet(key, agents, TTL_10M);
    return agents;
  } catch (err) {
    console.error('[getRoster]', err.message);
    return [];
  }
}

// ── Agent auth middleware ─────────────────────────────────────────────────────
function requireAgentAuth(req, res, next) {
  if (!AGENT_API_KEY) {
    console.warn('[agent-context] AGENT_API_KEY not set');
    return res.status(503).json({ error: 'agent_auth_not_configured' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (header.slice(7).trim() !== AGENT_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── Conversational KB search — routing tables ─────────────────────────────────
const AGENT_KB_PATHS = {
  arna:     ['kb/00-foundations', 'kb/01-business/Arna'],
  reid:     ['kb/01-business/Reid'],
  morgan:   ['kb/01-business/Morgan'],
  harlow:   ['kb/01-business/Harlow'],
  lumen:    ['kb/01-business/Lumen'],
  sterling: ['kb/01-business/Sterling'],
  steel:    ['kb/01-business/Steel'],
  casey:    ['kb/01-business/Casey'],
  wilder:   ['kb/01-business/Wilder'],
  wren:     ['kb/01-business/Content'],
  dev:      ['kb/04-resource/Dev'],
  clio:     ['kb/04-resource/Clio'],
  maren:    ['kb/04-resource/Maren'],
  vex:      ['kb/04-resource/Vex'],
  piper:    ['kb/04-resource/Piper'],
  flint:    ['kb/05-ikigai/platform-intelligence'],
  rook:     ['kb/04-resource/Rook'],
  mirror:   ['kb/02-workshop/Mirror'],
  scout:    ['kb/02-workshop/Scout'],
  sage:     ['kb/02-workshop/Sage'],
  rue:      ['kb/02-workshop/Rue'],
};

const ENTITY_KB_PATHS = {
  'inspector':          ['kb/01-business/ics'],
  'iops':               ['kb/01-business/products-and-services', 'kb/01-business/iai'],
  'clear ground':       ['kb/01-business/iai', 'kb/00-foundations'],
  'collapse the gap':   ['kb/01-business/iai', 'kb/00-foundations'],
  'hif':                ['kb/01-business/hif'],
  'hunter innovation':  ['kb/01-business/hif'],
  'project compliance': ['kb/01-business/ics'],
  'ics':                ['kb/01-business/ics'],
  'tmm':                ['kb/01-business/tmm'],
  'hma':                ['kb/01-business/hma'],
  'ikigai':             ['kb/05-ikigai'],
  'workshop':           ['kb/02-workshop'],
  'fractional':         ['kb/01-business/iai', 'kb/01-business/Reid'],
  'caio':               ['kb/01-business/iai', 'kb/01-business/Reid'],
  'ai index':           ['kb/01-business/iai', 'kb/00-foundations'],
  'industrial ai':      ['kb/01-business/iai', 'kb/00-foundations'],
  'lead generation':    ['kb/01-business/Morgan', 'kb/01-business/iai'],
  'linkedin':           ['kb/01-business/Morgan', 'kb/01-business/Wilder'],
  'vida':               ['kb/05-ikigai'],
  'indigo':             ['kb/01-business/hif'],
};

const STRUCTURAL_KB_PATHS = {
  'brief':        ['kb/00-foundations'],
  'decision':     ['kb/00-foundations'],
  'protocol':     ['kb/00-foundations'],
  'architecture': ['kb/00-foundations', 'kb/04-resource/Dev'],
  'session':      ['kb/00-foundations/session-intel'],
  'handover':     ['kb/00-foundations/session-intel'],
  'filing':       ['kb/00-foundations'],
  'migration':    ['kb/00-foundations/migration-status', 'kb/00-foundations'],
  'brand':        ['kb/00-foundations', 'kb/01-business/Lumen'],
  'sprint':       ['kb/00-foundations'],
  'roster':       ['kb/00-foundations'],
};

function routeQuestion(question) {
  const q = question.toLowerCase();
  const paths = new Set();
  let detectedAgent = null;

  for (const [kw, ps] of Object.entries(AGENT_KB_PATHS)) {
    if (q.includes(kw)) {
      ps.forEach(p => paths.add(p));
      if (!detectedAgent) detectedAgent = kw;
    }
  }
  for (const [kw, ps] of Object.entries(ENTITY_KB_PATHS)) {
    if (q.includes(kw)) ps.forEach(p => paths.add(p));
  }
  for (const [kw, ps] of Object.entries(STRUCTURAL_KB_PATHS)) {
    if (q.includes(kw)) ps.forEach(p => paths.add(p));
  }

  // If an agent was detected, always include both session intel folders so current
  // work context surfaces — filtered to that agent's files in fetchKBFilesForSearch
  // Two folders exist: session-intel (lowercase, recent) and Session Intel (title case, older)
  if (detectedAgent) {
    paths.add('kb/00-foundations/session-intel');
    paths.add('kb/00-foundations/Session Intel');
  }

  // Fallback — broad search across foundations and IAI business
  if (paths.size === 0) {
    paths.add('kb/00-foundations');
    paths.add('kb/01-business/iai');
  }

  return { paths: [...paths].slice(0, 7), agentFilter: detectedAgent };
}

async function fetchKBFilesForSearch(paths, agentFilter = null) {
  const allFiles = [];
  await Promise.all(paths.map(async p => {
    try {
      const files = await fetchKBDir(p);
      files.filter(f => /\.(md|txt)$/i.test(f.name)).forEach(f => allFiles.push(f));
    } catch { /* skip failed paths */ }
  }));

  // Scoring:
  //   5 — session intel for the detected agent (most current context)
  //   3 — session intel (no agent filter, or structural session query)
  //   2 — briefs/specs/architecture/protocol
  //   1 — everything else
  //   0 — other agents' session intel when an agent filter is active (deprioritise)
  allFiles.sort((a, b) => {
    const score = f => {
      const isSessionIntel = /sessionintel/i.test(f.name);
      if (isSessionIntel) {
        if (agentFilter) {
          return f.name.toLowerCase().startsWith(agentFilter) ? 5 : 0;
        }
        return 3;
      }
      return /brief|spec|architecture|protocol/i.test(f.name) ? 2 : 1;
    };
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : b.name.localeCompare(a.name);
  });

  return allFiles.slice(0, 12);
}

async function buildSearchContext(files) {
  const CHAR_CAP = 80000; // ~20k tokens
  const chunks = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= CHAR_CAP) break;
    try {
      const text = await fetchRawText(file.path);
      if (!text) continue;
      const excerpt = text.slice(0, CHAR_CAP - totalChars);
      chunks.push({ path: file.path, name: file.name, text: excerpt });
      totalChars += excerpt.length;
    } catch { /* skip */ }
  }

  return chunks;
}

// ── Agent Context endpoints ───────────────────────────────────────────────────
app.get('/api/agent-context/:agent_id', requireAgentAuth, async (req, res) => {
  if (!turso) return res.status(503).json({ error: 'turso_not_configured' });
  const { agent_id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '3', 10), 10);
  try {
    const result = await turso.execute({
      sql: `SELECT id, agent_id, session_date, context_json, created_at
            FROM agent_context
            WHERE agent_id = ?
            ORDER BY session_date DESC, id DESC
            LIMIT ?`,
      args: [agent_id, limit],
    });
    const records = result.rows.map(row => ({
      id: row.id,
      agent_id: row.agent_id,
      session_date: row.session_date,
      context_json: (() => { try { return JSON.parse(row.context_json); } catch { return row.context_json; } })(),
      created_at: row.created_at,
    }));
    return res.json({ agent_id, records });
  } catch (err) {
    console.error('[GET /api/agent-context]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/agent-context', requireAgentAuth, express.json(), async (req, res) => {
  if (!turso) return res.status(503).json({ error: 'turso_not_configured' });
  const { agent, session_date, context_json } = req.body || {};
  if (!agent || !session_date) {
    return res.status(400).json({ error: 'agent and session_date are required' });
  }
  try {
    const result = await turso.execute({
      sql: `INSERT INTO agent_context (agent_id, session_date, context_json)
            VALUES (?, ?, ?)
            RETURNING id, agent_id, session_date, created_at`,
      args: [agent, session_date, JSON.stringify(context_json || {})],
    });
    const row = result.rows[0];
    return res.status(201).json({
      id: row.id, agent_id: row.agent_id,
      session_date: row.session_date, created_at: row.created_at,
    });
  } catch (err) {
    console.error('[POST /api/agent-context]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

// ── Public endpoints ──────────────────────────────────────────────────────────
app.get('/api/public/completions/summary', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=600');
  const cacheKey = 'public:completions:summary';
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  if (!SHEETS_API_KEY || !SHEETS_SPREADSHEET_ID) {
    return res.json({ total: null, sectors: {}, error: 'sheets_not_configured' });
  }
  try {
    const range = encodeURIComponent('Sheet2!A2:Z1000');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_SPREADSHEET_ID}/values/${range}?key=${SHEETS_API_KEY}`;
    const sheetsRes = await fetch(url, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
    if (!sheetsRes.ok) return res.json({ total: null, sectors: {}, error: 'sheets_fetch_failed' });
    const data = await sheetsRes.json();
    const rows = data.values || [];
    const sectors = {};
    for (const row of rows) {
      const sector = (row[SHEETS_SECTOR_COL] || '').trim();
      if (sector) sectors[sector] = (sectors[sector] || 0) + 1;
    }
    const result = { total: rows.length, sectors, cached_at: new Date().toISOString() };
    cacheSet(cacheKey, result, TTL_10M);
    return res.json(result);
  } catch (err) {
    console.error('[public/completions/summary]', err.message);
    return res.json({ total: null, sectors: {}, error: 'internal' });
  }
});

// ── PWA static assets (public — must be before auth) ─────────────────────────
app.get('/manifest.json', (_req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/icon-192.png',  (_req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png',  (_req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));

// ── Session cookie + Google OAuth routes (public — before site auth) ─────────
if (GOOGLE_AUTH_ENABLED) {
  app.set('trust proxy', 1);
  app.use(cookieSession({
    name:     'base_sess',
    keys:     [SESSION_SECRET],
    maxAge:   30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   true,
    sameSite: 'lax',
  }));

  app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/')
      ? req.query.returnTo : '/';
    req.session.returnTo = returnTo;
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope:         'openid email profile',
      access_type:   'online',
      prompt:        'select_account',
      state,
    });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(401).send('Sign-in failed: ' + String(error));
    if (!code || !state) return res.status(400).send('Missing code or state.');
    if (state !== req.session.oauthState) {
      return res.status(400).send('Bad state — <a href="/auth/login">try signing in again</a>.');
    }
    req.session.oauthState = undefined;
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code:          String(code),
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri:  OAUTH_REDIRECT_URI,
          grant_type:    'authorization_code',
        }),
      });
      if (!tokenRes.ok) {
        console.error('[oauth] token exchange failed:', tokenRes.status, await tokenRes.text());
        return res.status(502).send('Google token exchange failed.');
      }
      const tokens = await tokenRes.json();
      const payload = decodeJwtPayload(tokens.id_token);
      if (!payload || !payload.email) return res.status(502).send('No email in Google response.');
      const email = String(payload.email).toLowerCase();
      const verified = payload.email_verified !== false;
      if (!verified || !isAllowedEmail(email)) {
        console.warn('[oauth] rejected sign-in for', email);
        return res.status(403).send(
          `<html><body style="font-family:sans-serif;padding:2em;max-width:32em;">` +
          `<h2>Not authorised</h2>` +
          `<p>The Google account <code>${email}</code> is not on Base's allowlist.</p>` +
          `<p><a href="/auth/logout">Try a different account</a></p></body></html>`
        );
      }
      req.session.email = email;
      req.session.loggedInAt = Date.now();
      const returnTo = (typeof req.session.returnTo === 'string' && req.session.returnTo.startsWith('/'))
        ? req.session.returnTo : '/';
      req.session.returnTo = undefined;
      return res.redirect(returnTo);
    } catch (err) {
      console.error('[oauth] callback error:', err);
      return res.status(500).send('OAuth callback error.');
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session = null;
    res.send(
      `<html><body style="font-family:sans-serif;padding:2em;max-width:32em;">` +
      `<h2>Signed out of Base</h2>` +
      `<p><a href="/auth/login">Sign back in</a></p></body></html>`
    );
  });
}

// ── Apply site-wide auth ───────────────────────────────────────────────────────
app.use(requireSiteAuth);

// ── API Routes ────────────────────────────────────────────────────────────────

// KB directory listing
app.get('/api/kb', async (req, res) => {
  const kbPath = req.query.path;
  if (!kbPath) return res.status(400).json({ error: 'Missing path param' });
  const key = `kb:${kbPath}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const encoded = kbPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `https://api.github.com/repos/${KB_REPO}/contents/${encoded}`;
    const data = await ghFetch(url, true);
    const result = Array.isArray(data) ? data : (data ? [data] : []);
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/kb]', err.message);
    return res.json([]);
  }
});

// KB code search
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.trim().length < 2) return res.json({ items: [] });
  const key = `search:${q.trim().toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q.trim())}+repo:${KB_REPO}&per_page=30`;
    const data = await ghFetch(url, true);
    if (!data) {
      console.error('[GET /api/search] GitHub returned null — check PAT scopes and validity');
      return res.json({ items: [], error: 'github_auth' });
    }
    cacheSet(key, data, TTL_5M);
    return res.json(data);
  } catch (err) {
    console.error('[GET /api/search]', err.message);
    return res.json({ items: [] });
  }
});

// Agent portraits — public repo
app.get('/api/portraits', async (req, res) => {
  const key = 'portraits';
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const data = await ghFetch(`https://api.github.com/repos/${PORTRAITS_REPO}/contents/portraits`, false);
    const result = data || [];
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/portraits]', err.message);
    return res.json([]);
  }
});

// Raw file proxy for private KB
app.get('/api/raw', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).end();
  try {
    const url = `https://raw.githubusercontent.com/${KB_REPO}/main/${filePath}`;
    const headers = { 'User-Agent': 'IAI-Base/3.0' };
    if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('[GET /api/raw]', err.message);
    return res.status(500).end();
  }
});

// ── HTML file viewer — /view?path=... ────────────────────────────────────────
// Serves .html KB files full-page with the Base nav bar injected at the top
app.get('/view', async (req, res) => {
  const filePath = (req.query.path || '').trim();
  const fromParam = (req.query.from || '/').trim();
  if (!filePath || !filePath.toLowerCase().endsWith('.html')) {
    return res.status(400).send('Only .html files are supported via /view');
  }
  try {
    const encoded = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url     = `https://raw.githubusercontent.com/${KB_REPO}/main/${encoded}`;
    const headers = { 'User-Agent': 'IAI-Base/3.0' };
    if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(r.status).send('File not found');
    let html = await r.text();

    const backHref = fromParam || '/';
    const navHtml = `
<style>
#_bnav{position:fixed;top:0;left:0;right:0;z-index:2147483647;height:48px;
  background:#fff;border-bottom:1px solid rgba(28,36,44,0.10);
  display:flex;align-items:center;padding:0 20px;gap:16px;
  font-family:'IBM Plex Mono',monospace;box-sizing:border-box;
  box-shadow:0 1px 6px rgba(0,0,0,0.06);}
#_bnav a{text-decoration:none;}
#_bnav-dot{width:28px;height:28px;background:#0E1117;border-radius:6px;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;}
#_bnav-dot span{display:block;width:8px;height:8px;border-radius:50%;background:#D66A35;}
#_bnav-wm{display:flex;flex-direction:column;line-height:1.25;flex-shrink:0;}
#_bnav-name{font-size:12px;font-weight:600;color:#1C242C;letter-spacing:0.02em;}
#_bnav-sub{font-size:9px;color:#8A9BB0;letter-spacing:0.06em;}
#_bnav-links{display:flex;gap:14px;margin-left:8px;}
#_bnav-links a{font-size:11px;color:#4A6584;letter-spacing:0.04em;display:flex;align-items:center;gap:4px;}
#_bnav-links a::before{content:'●';font-size:5px;color:#4A6584;}
#_bnav-back{margin-left:auto;font-size:11px;color:#4A6584;letter-spacing:0.04em;white-space:nowrap;}
#_bnav-back:hover{color:#1C242C;}
body{padding-top:48px!important;}
</style>
<div id="_bnav">
  <a href="/" id="_bnav-dot-lnk"><div id="_bnav-dot"><span></span></div></a>
  <div id="_bnav-wm">
    <span id="_bnav-name">BASE.</span>
    <span id="_bnav-sub">Integrated AI</span>
  </div>
  <div id="_bnav-links">
    <a href="https://grid.integratedai.com.au" target="_blank">Grid.IO</a>
    <a href="https://marnie-io.vercel.app" target="_blank">Mio</a>
    <a href="/" target="_blank">DI</a>
  </div>
  <a href="${backHref}" id="_bnav-back">← Back to Base</a>
</div>`;

    // Inject nav after opening <body> tag (or prepend if none found)
    const bodyMatch = html.match(/<body[^>]*>/i);
    if (bodyMatch) {
      const idx = html.indexOf(bodyMatch[0]) + bodyMatch[0].length;
      html = html.slice(0, idx) + navHtml + html.slice(idx);
    } else {
      html = navHtml + html;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(html);
  } catch (err) {
    console.error('[GET /view]', err.message);
    return res.status(500).send('Could not load file');
  }
});

// Agent roster
app.get('/api/roster', async (_req, res) => {
  try {
    const agents = await getRoster();
    return res.json(agents);
  } catch { return res.json([]); }
});

// Agent constellation data
app.get('/api/agent/:slug', async (req, res) => {
  const { slug } = req.params;
  const key = `agent:${slug}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const roster = await getRoster();
    const agent = roster.find(a => a.slug === slug);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const portraitUrl = `${PORTRAITS_RAW}${agent.name}_headshot.png`;
    const agentDocs = await fetchKBDir('kb/00-foundations/agents');
    const identity = agentDocs
      .filter(f => f.name.toLowerCase().includes(`prompt-${slug}`))
      .sort((a, b) => b.name.localeCompare(a.name));
    const searchResults = await searchKB(agent.name);
    const briefs = searchResults.filter(f => {
      const n = f.name.toLowerCase();
      const p = f.path.toLowerCase();
      if (p.includes('/agents/')) return false;
      return /brief|handover|devspec|devbrief|spec|induction/.test(n);
    }).slice(0, 12);
    const related = roster.filter(a =>
      a.slug !== slug && !['petra'].includes(a.slug) && (
        a.point === agent.point ||
        a.slug === agent.reportsTo ||
        a.reportsTo === slug
      )
    ).slice(0, 8);
    const reportsToAgent = agent.reportsTo ? roster.find(a => a.slug === agent.reportsTo) : null;
    const result = {
      ...agent, portraitUrl,
      reportsToName: reportsToAgent ? reportsToAgent.name : null,
      identity: identity.map(f => ({ name: f.name, path: f.path, url: `https://github.com/${KB_REPO}/blob/main/${f.path}` })),
      briefs:   briefs.map(f => ({ name: f.name, path: f.path, url: `https://github.com/${KB_REPO}/blob/main/${f.path}` })),
      related:  related.map(a => ({ name: a.name, slug: a.slug, role: a.role, point: a.point, status: a.status })),
    };
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/agent/:slug]', err.message);
    return res.status(500).json({ error: 'Failed to load agent data' });
  }
});

// File last-commit metadata
app.get('/api/filemeta', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  const key = `filemeta:${filePath}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const url = `https://api.github.com/repos/${KB_REPO}/commits?path=${encodeURIComponent(filePath)}&per_page=1`;
    const data = await ghFetch(url, true);
    const commit = Array.isArray(data) && data[0] ? data[0] : null;
    const iso = commit ? (commit.commit.committer.date || commit.commit.author.date) : null;
    let date = '';
    if (iso) {
      const d = new Date(iso);
      date = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '');
    }
    const result = { date };
    cacheSet(key, result, TTL_60M);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/filemeta]', err.message);
    return res.json({ date: '' });
  }
});

// ── Pursuits registry — proxy to Grid API ─────────────────────────────────────
app.get('/api/pursuits', async (_req, res) => {
  const key = 'pursuits:list';
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(`${GRID_API}/pursuits`, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
    if (!r.ok) return res.status(r.status).json({ error: 'Grid API error' });
    const data = await r.json();
    cacheSet(key, data, TTL_5M);
    return res.json(data);
  } catch (err) {
    console.error('[GET /api/pursuits]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/pursuits/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const key  = `pursuits:${code}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(`${GRID_API}/pursuits/${code}`, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
    if (r.status === 404) return res.status(404).json({ error: 'Pursuit not found' });
    if (!r.ok) return res.status(r.status).json({ error: 'Grid API error' });
    const data = await r.json();
    cacheSet(key, data, TTL_5M);
    return res.json(data);
  } catch (err) {
    console.error(`[GET /api/pursuits/${req.params.code}]`, err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

// ── Live data routing (id:522) ────────────────────────────────────────────────
// Detects whether a question needs live Grid API data (sprint board, pursuits)
// in addition to or instead of static KB files.

const SPRINT_TRIGGER_WORDS = [
  'sprint', 'board', 'card', 'backlog', 'gate', 'blocked', 'active',
  'working on', "what's on", 'what is on', 'assigned', 'task', 'doing',
  'what are', 'what have', 'status',
];
const PURSUIT_TRIGGER_WORDS = [
  'pursuit', 'constellation', 'iops', 'hif', 'hunter innovation',
  'hma', 'hunter manufacturing', 'hed', 'hedweld', 'workshop pursuit',
];
const PURSUIT_CODES = ['io', 'hif', 'hma', 'hed', 'ws', 'pc'];
const ALL_AGENT_SLUGS = Object.keys(AGENT_KB_PATHS);

function detectLiveDataNeeds(question) {
  const q = question.toLowerCase();
  const detectedAgent = ALL_AGENT_SLUGS.find(a => q.includes(a)) || null;
  const needsSprint   = SPRINT_TRIGGER_WORDS.some(k => q.includes(k)) || !!detectedAgent;
  const needsPursuits = PURSUIT_TRIGGER_WORDS.some(k => q.includes(k));
  const pursuitCode   = needsPursuits ? (PURSUIT_CODES.find(c => q.includes(c)) || null) : null;
  return { needsSprint, sprintAgent: detectedAgent, needsPursuits, pursuitCode };
}

async function fetchLiveContext(needs) {
  const sections = [];

  if (needs.needsSprint) {
    try {
      const url = needs.sprintAgent
        ? `${GRID_API}/sprint?agent=${encodeURIComponent(needs.sprintAgent)}`
        : `${GRID_API}/sprint`;
      const r = await fetch(url, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
      if (r.ok) {
        const data  = await r.json();
        const tasks = (data.tasks || [])
          .filter(t => !['superseded', 'dumpster'].includes(t.status))
          .slice(0, 40);
        const lines = tasks.map(t =>
          `  id:${t.id} [${t.status}] [${t.priority}] ${t.title}` +
          (t.owner ? ` — ${t.owner}` : '') +
          (t.blockedReason ? ` BLOCKED: ${t.blockedReason}` : '')
        ).join('\n');
        const label = needs.sprintAgent
          ? `LIVE SPRINT BOARD — ${needs.sprintAgent} (${tasks.length} cards)`
          : `LIVE SPRINT BOARD (${tasks.length} cards shown)`;
        sections.push(`${label}:\n${lines}`);
      }
    } catch (err) {
      console.warn('[fetchLiveContext] sprint fetch failed:', err.message);
    }
  }

  if (needs.needsPursuits) {
    try {
      const url = needs.pursuitCode
        ? `${GRID_API}/pursuits/${needs.pursuitCode.toUpperCase()}`
        : `${GRID_API}/pursuits`;
      const r = await fetch(url, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
      if (r.ok) {
        const data = await r.json();
        const text = JSON.stringify(data, null, 2).slice(0, 6000);
        sections.push(`LIVE PURSUITS DATA:\n${text}`);
      }
    } catch (err) {
      console.warn('[fetchLiveContext] pursuits fetch failed:', err.message);
    }
  }

  return sections;
}

// ── Conversational KB search — /api/ask ───────────────────────────────────────
// Accepts: GET /api/ask?q=<new question>&ctx=<conversation history (optional)>
// q  — used for KB file routing + live data detection (THIS question only)
// ctx — passed to Anthropic for synthesis context (not used for routing)
// Returns: { answer: string, sources: Array<{name,path}>, live: boolean }
app.get('/api/ask', async (req, res) => {
  const question = (req.query.q   || '').trim();
  const ctx      = (req.query.ctx || '').trim();
  if (question.length < 2) return res.status(400).json({ error: 'query too short' });
  if (!ANTHROPIC_API_KEY) {
    console.error('[/api/ask] ANTHROPIC_API_KEY not set');
    return res.status(503).json({ error: 'Search not configured — ANTHROPIC_API_KEY missing' });
  }

  try {
    // Run KB routing and live data detection in parallel
    const liveNeeds = detectLiveDataNeeds(question);
    const { paths, agentFilter } = routeQuestion(question);

    const [files, liveSections] = await Promise.all([
      fetchKBFilesForSearch(paths, agentFilter),
      fetchLiveContext(liveNeeds),
    ]);

    const kbContext   = await buildSearchContext(files);
    const hasContent  = kbContext.length > 0 || liveSections.length > 0;

    if (!hasContent) {
      return res.json({
        answer: 'Nothing relevant found for that question. Try rephrasing with an agent name, project name, or topic.',
        sources: [],
        live: false,
      });
    }

    // Build context block — live data first (most current), then KB files
    const liveBlock = liveSections.length
      ? `=== LIVE DATA (fetched now from Grid API) ===\n\n${liveSections.join('\n\n')}\n\n`
      : '';
    const kbBlock = kbContext.length
      ? `=== KB FILES ===\n\n${kbContext.map(c => `--- FILE: ${c.path} ---\n${c.text}`).join('\n\n')}`
      : '';
    const contextBlock = liveBlock + kbBlock;

    const systemPrompt = [
      'You are Base, the IAI internal knowledge interface.',
      'You answer questions about how Integrated AI (IAI) works — its agents, decisions, projects, and operating protocols.',
      'You have access to both live data from the Grid API (sprint board, pursuits) and static KB files.',
      '',
      'Rules:',
      '- Answer directly and concisely. No preamble, no filler.',
      '- Australian English. No em dashes. Use commas, colons, or new sentences instead.',
      '- When live data is present, prioritise it over KB files for current state questions.',
      '- Cite sources: KB files by filename, live data as "sprint board" or "pursuits data".',
      '- If the answer is partial or uncertain, say so clearly.',
      '- If the user says "yes" or gives a short affirmative, check the conversation context and respond accordingly.',
      '- End with a brief offer to surface a specific file if genuinely useful.',
      '- Do not fabricate. If nothing answers the question, say so directly.',
    ].join('\n');

    const ctxSection  = ctx ? `Conversation so far:\n${ctx}\n\n---\n\n` : '';
    const userMessage = `Context retrieved:\n\n${contextBlock}\n\n---\n\n${ctxSection}New question: ${question}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 1024,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('[/api/ask] Anthropic error:', anthropicRes.status, errText);
      let errDetail = '';
      try { errDetail = JSON.parse(errText)?.error?.message || ''; } catch { /* ignore */ }
      return res.status(502).json({ error: `Synthesis failed (${anthropicRes.status})${errDetail ? ': ' + errDetail : ' — check ANTHROPIC_API_KEY and model access'}` });
    }

    const data   = await anthropicRes.json();
    const answer = data.content?.[0]?.text || 'No response generated.';
    const sources = [
      ...kbContext.map(c => ({ name: c.name, path: c.path })),
      ...(liveSections.length ? [{ name: 'Grid API (live)', path: GRID_API }] : []),
    ];

    return res.json({ answer, sources, live: liveSections.length > 0 });

  } catch (err) {
    console.error('[/api/ask]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

// Diagnostic
app.get('/api/debug', async (_req, res) => {
  const headers = { 'User-Agent': 'IAI-Base/3.0', 'Accept': 'application/vnd.github.v3+json' };
  if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  let contentsStatus, contentsPreview, contentsErr;
  try {
    const r = await fetch(`https://api.github.com/repos/${KB_REPO}/contents/kb/00-foundations`, { headers });
    contentsStatus = r.status;
    contentsPreview = (await r.text()).slice(0, 200);
  } catch (err) { contentsErr = err.message; }
  let searchStatus, searchPreview, searchErr;
  try {
    const r = await fetch(`https://api.github.com/search/code?q=arna+repo:${KB_REPO}&per_page=1`, { headers });
    searchStatus = r.status;
    searchPreview = (await r.text()).slice(0, 200);
  } catch (err) { searchErr = err.message; }
  return res.json({
    patSet: !!GITHUB_PAT, anthropicSet: !!ANTHROPIC_API_KEY,
    patPrefix: GITHUB_PAT ? GITHUB_PAT.slice(0, 10) + '…' : null,
    patType: GITHUB_PAT ? (GITHUB_PAT.startsWith('ghp_') ? 'classic' : GITHUB_PAT.startsWith('github_pat_') ? 'fine-grained' : 'unknown') : 'not set',
    contents: { status: contentsStatus, preview: contentsPreview, error: contentsErr },
    search:   { status: searchStatus,   preview: searchPreview,   error: searchErr },
  });
});

// ── Dashboards ────────────────────────────────────────────────────────────────
app.get(['/dashboards', '/dashboards/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'index.html'));
});
app.get('/dashboards/Index', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'index-analytics.html'));
});
app.get('/dashboards/clear-ground', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'clear-ground.html'));
});
app.get('/dashboards/clear-ground-metrics', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'clear-ground-metrics.html'));
});
app.get('/dashboards/iai-website', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'iai-website.html'));
});
app.use('/dashboards', express.static(path.join(__dirname, 'dashboards')));

// In-app document reader
app.get('/read', (_req, res) => {
  res.sendFile(path.join(__dirname, 'read.html'));
});

// Agent constellation page
app.get('/agent/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agent.html'));
});

// Pursuits index and per-pursuit detail
app.get('/pursuits',       (_req, res) => res.sendFile(path.join(__dirname, 'pursuits.html')));
app.get('/pursuits/:code', (_req, res) => res.sendFile(path.join(__dirname, 'pursuit-detail.html')));

// Main intranet — catch-all
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Base listening on :${PORT}`);
  if (!GITHUB_PAT)        console.warn('[!] GITHUB_PAT not set — KB endpoints will return empty results');
  if (!ANTHROPIC_API_KEY) console.warn('[!] ANTHROPIC_API_KEY not set — /api/ask will return 503');
  await initAgentContextTable();
});
