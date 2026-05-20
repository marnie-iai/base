'use strict';

const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 8080;
const GITHUB_PAT      = process.env.GITHUB_PAT;
const SITE_AUTH       = process.env.SITE_AUTH;
const DASHBOARD_AUTH  = process.env.DASHBOARD_AUTH;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KB_REPO = 'marnie-iai/kb';
const PORTRAITS_REPO = 'marnie-iai/agent-portraits';
const PORTRAITS_RAW = `https://raw.githubusercontent.com/${PORTRAITS_REPO}/main/portraits/`;
const ROSTER_FILE = 'kb/00-foundations/00_Agent_Roster_v2_2_Apr2026.md';

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

// ── Site-wide Basic Auth ──────────────────────────────────────────────────────
function requireSiteAuth(req, res, next) {
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

// ── Dashboard auth middleware ──────────────────────────────────────────────────
function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_AUTH) return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="IAI Dashboards"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
  if (pass !== DASHBOARD_AUTH) {
    res.setHeader('WWW-Authenticate', 'Basic realm="IAI Dashboards"');
    return res.status(401).send('Incorrect credentials');
  }
  next();
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
    const data = await ghFetch(`https://api.github.com/repos/${KB_REPO}/contents/${kbPath}`, true);
    const result = Array.isArray(data) ? data.filter(f => f.type === 'file') : [];
    cacheSet(key, result);
    return result;
  } catch { return []; }
}

async function fetchRawText(kbPath) {
  try {
    const url = `https://raw.githubusercontent.com/${KB_REPO}/main/${kbPath}`;
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
  'hunter':             ['kb/01-business/hif'],
  'project compliance': ['kb/01-business/ics'],
  'ics':                ['kb/01-business/ics'],
  'tmm':                ['kb/01-business/tmm'],
  'hma':                ['kb/01-business/hma'],
  'ikigai':             ['kb/05-ikigai'],
  'workshop':           ['kb/02-workshop'],
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

  for (const [kw, ps] of Object.entries(AGENT_KB_PATHS)) {
    if (q.includes(kw)) ps.forEach(p => paths.add(p));
  }
  for (const [kw, ps] of Object.entries(ENTITY_KB_PATHS)) {
    if (q.includes(kw)) ps.forEach(p => paths.add(p));
  }
  for (const [kw, ps] of Object.entries(STRUCTURAL_KB_PATHS)) {
    if (q.includes(kw)) ps.forEach(p => paths.add(p));
  }

  // Fallback — broad search across foundations and IAI business
  if (paths.size === 0) {
    paths.add('kb/00-foundations');
    paths.add('kb/01-business/iai');
  }

  return [...paths].slice(0, 6);
}

async function fetchKBFilesForSearch(paths) {
  const allFiles = [];
  await Promise.all(paths.map(async p => {
    try {
      const files = await fetchKBDir(p);
      files.filter(f => /\.(md|txt)$/i.test(f.name)).forEach(f => allFiles.push(f));
    } catch { /* skip failed paths */ }
  }));

  // Priority: session intel > briefs/specs > everything else; recency within group
  allFiles.sort((a, b) => {
    const score = f => /sessionintel/i.test(f.name) ? 3 : /brief|spec|architecture|protocol/i.test(f.name) ? 2 : 1;
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
    const url = `https://api.github.com/repos/${KB_REPO}/contents/${kbPath}`;
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

// ── Conversational KB search — /api/ask ───────────────────────────────────────
// Accepts: GET /api/ask?q=<question>
// Returns: { answer: string, sources: string[] }
app.get('/api/ask', async (req, res) => {
  const question = (req.query.q || '').trim();
  if (question.length < 3) return res.status(400).json({ error: 'query too short' });
  if (!ANTHROPIC_API_KEY) {
    console.error('[/api/ask] ANTHROPIC_API_KEY not set');
    return res.status(503).json({ error: 'Search not configured — ANTHROPIC_API_KEY missing' });
  }

  try {
    const paths   = routeQuestion(question);
    const files   = await fetchKBFilesForSearch(paths);
    const context = await buildSearchContext(files);

    if (!context.length) {
      return res.json({
        answer: 'Nothing relevant found in the KB for that question. Try rephrasing with an agent name, project name, or topic.',
        sources: [],
      });
    }

    const contextBlock = context.map(c => `--- FILE: ${c.path} ---\n${c.text}`).join('\n\n');

    const systemPrompt = [
      'You are Base, the IAI internal knowledge interface.',
      'You answer questions about how Integrated AI (IAI) works — its agents, decisions, projects, and operating protocols — by synthesising information from the IAI knowledge base.',
      '',
      'Rules:',
      '- Answer directly and concisely. No preamble, no filler.',
      '- Australian English. No em dashes. Use commas, colons, or new sentences instead.',
      '- Cite which KB files you drew from by filename (not full path) at the end of your answer.',
      '- If the answer is partial or uncertain, say so clearly.',
      '- End with a brief offer to surface a specific file if useful: "Want me to pull up [filename]?" Only include this if there is something genuinely worth surfacing.',
      '- If nothing in the provided files answers the question, say so directly. Do not fabricate.',
    ].join('\n');

    const userMessage = `KB files retrieved:\n\n${contextBlock}\n\n---\n\nQuestion: ${question}`;

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

    const data    = await anthropicRes.json();
    const answer  = data.content?.[0]?.text || 'No response generated.';
    const sources = context.map(c => c.name);

    return res.json({ answer, sources });

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
app.get('/dashboards/Index', requireDashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'index-analytics.html'));
});
app.get('/dashboards/clear-ground', requireDashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'clear-ground.html'));
});
app.get('/dashboards/clear-ground-metrics', requireDashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'clear-ground-metrics.html'));
});
app.get('/dashboards/iai-website', requireDashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboards', 'iai-website.html'));
});
app.use('/dashboards', requireDashboardAuth, express.static(path.join(__dirname, 'dashboards')));

app.get('/read',        (_req, res) => res.sendFile(path.join(__dirname, 'read.html')));
app.get('/agent/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'agent.html')));
app.get('*',            (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, async () => {
  console.log(`Base listening on :${PORT}`);
  if (!GITHUB_PAT)        console.warn('[!] GITHUB_PAT not set — KB endpoints will return empty results');
  if (!ANTHROPIC_API_KEY) console.warn('[!] ANTHROPIC_API_KEY not set — /api/ask will return 503');
  await initAgentContextTable();
});
