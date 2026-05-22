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
const ROSTER_FILE = 'kb/00-foundations/00_Agent_Roster_v2_4_May2026.md';
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
  mel:      ['kb/04-resource/Dev'],
  jd:       ['kb/04-resource/Dev'],
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

// ── Multi-source intent detection — sprint board | pursuits DB | KB files ─────

const SPRINT_AGENT_NAMES = [
  'arna','reid','morgan','harlow','lumen','sterling','steel','casey',
  'wilder','dev','mel','jd','clio','maren','vex','piper','flint','rook',
  'mirror','scout','sage','rue','wren','alex',
];

function detectQueryIntent(question) {
  const q = question.toLowerCase();
  const SPRINT_KEYWORDS = [
    'card','cards','sprint','working on','open card','assigned','due this week',
    'in progress','blocked','backlog','active card','gate card','review card',
  ];
  const hasSprintKeyword = SPRINT_KEYWORDS.some(kw => q.includes(kw));
  const hasAgentWorkQuery = SPRINT_AGENT_NAMES.some(a => q.includes(a)) &&
    ['working','doing','card','sprint','open','active','up to','assigned','what'].some(w => q.includes(w));
  if (hasSprintKeyword || hasAgentWorkQuery) return 'sprint';

  const PURSUIT_KEYWORDS = ["constellation","who's on","who is on","pursuit","who works on"];
  const PURSUIT_NAMES = [
    'iops','i-ops','project compliance','hunter innovation festival',
    'hunter manufacturing awards','hed','hedweld',
  ];
  if (
    PURSUIT_KEYWORDS.some(kw => q.includes(kw)) ||
    PURSUIT_NAMES.some(n => q.includes(n))
  ) return 'pursuit';

  return 'kb';
}

async function fetchSprintContext(question) {
  const q = question.toLowerCase();
  const detectedAgent = SPRINT_AGENT_NAMES.find(a => q.includes(a));
  try {
    const r = await fetch(`${GRID_API}/sprint`, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const tasks = data.tasks || data || [];
    let filtered = tasks;
    if (detectedAgent) {
      filtered = tasks.filter(t => t.owner && t.owner.toLowerCase() === detectedAgent.toLowerCase());
    }
    const active = filtered.filter(t =>
      ['active','review','gate','blocked'].includes((t.status || '').toLowerCase())
    );
    const toShow = active.length > 0 ? active : filtered.filter(t => t.status === 'complete').slice(0, 10);
    const summary = toShow.slice(0, 25).map(t =>
      `id:${t.id} | ${t.status} | Owner: ${t.owner} | Priority: ${t.priority} | ${t.title}` +
      (t.sessionNotes ? `\n  Notes: ${String(t.sessionNotes).slice(0, 200)}` : '') +
      (t.blockedReason ? `\n  Blocked: ${t.blockedReason}` : '')
    ).join('\n');
    return { source: 'sprint board', agentFilter: detectedAgent || null, summary, total: toShow.length };
  } catch (err) {
    console.error('[fetchSprintContext]', err.message);
    return null;
  }
}

async function fetchPursuitContext(question) {
  const q = question.toLowerCase();
  const PURSUIT_MAP = [
    { keywords: ['iops','i-ops'], code: 'IO' },
    { keywords: ['project compliance','inspector'], code: 'PC' },
    { keywords: ['hif','hunter innovation'], code: 'HIF' },
    { keywords: ['hma','hunter manufacturing'], code: 'HMA' },
    { keywords: ['hed','hedweld'], code: 'HED' },
    { keywords: ['workshop'], code: 'WS' },
  ];
  const match = PURSUIT_MAP.find(p => p.keywords.some(kw => q.includes(kw)));
  try {
    if (match) {
      const r = await fetch(`${GRID_API}/pursuits/${match.code}`, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
      if (!r.ok) return null;
      const data = await r.json();
      let summary = `Pursuit: ${match.code}`;
      if (data.pursuit) {
        summary += `\nName: ${data.pursuit.name || ''}\nStatus: ${data.pursuit.status || ''}`;
        if (data.pursuit.description) summary += `\nDescription: ${data.pursuit.description}`;
      }
      if (data.members && data.members.length) {
        summary += '\n\nConstellation:\n' + data.members.map(m => `  ${m.agent_name || m.agent}: ${m.role || ''}`).join('\n');
      }
      if (data.sprints) {
        const activeSprints = (data.sprints || []).filter(s =>
          ['active','review','gate','blocked'].includes((s.status || '').toLowerCase())
        );
        if (activeSprints.length) {
          summary += '\n\nActive cards:\n' + activeSprints.slice(0, 15).map(s => `  id:${s.id} | ${s.status} | ${s.title}`).join('\n');
        }
      }
      return { source: 'pursuits', code: match.code, summary };
    } else {
      const r = await fetch(`${GRID_API}/pursuits`, { headers: { 'User-Agent': 'IAI-Base/3.0' } });
      if (!r.ok) return null;
      const data = await r.json();
      const pursuits = Array.isArray(data) ? data : (data.pursuits || []);
      const summary = 'Active pursuits:\n' + pursuits.map(p => `  ${p.code}: ${p.name} — ${p.status}`).join('\n');
      return { source: 'pursuits', code: null, summary };
    }
  } catch (err) {
    console.error('[fetchPursuitContext]', err.message);
    return null;
  }
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
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
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

// KB file search — uses Git Trees API for reliable filename + path matching
// (GitHub code search API is unreliable on private repos and has strict rate limits)
const KB_TREE_CACHE_KEY = 'kb_tree_v1';
const KB_TREE_TTL = 5 * 60 * 1000; // 5 min

async function getKBTree() {
  const cached = cacheGet(KB_TREE_CACHE_KEY);
  if (cached) return cached;
  const data = await ghFetch(
    `https://api.github.com/repos/${KB_REPO}/git/trees/main?recursive=1`,
    true
  );
  if (!data || !Array.isArray(data.tree)) return null;
  const tree = data.tree.filter(f => f.type === 'blob' && f.path.startsWith('kb/'));
  cacheSet(KB_TREE_CACHE_KEY, tree, KB_TREE_TTL);
  return tree;
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  try {
    const tree = await getKBTree();
    if (!tree) {
      console.error('[GET /api/search] KB tree unavailable — check GITHUB_PAT');
      return res.json({ items: [] });
    }
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = tree
      .filter(f => {
        const lp = f.path.toLowerCase();
        return terms.every(t => lp.includes(t));
      })
      .slice(0, 30)
      .map(f => ({ name: f.path.split('/').pop(), path: f.path }));
    return res.json({ items });
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

// ── Conversational search — /api/ask ─────────────────────────────────────────
// Routes to: sprint board | pursuits DB | KB files — based on intent detection
// Accepts: GET /api/ask?q=<question>&ctx=<conversation history (optional)>
// Returns: { answer: string, sources: Array<{name,path}>, intent: string }
app.get('/api/ask', async (req, res) => {
  const question = (req.query.q   || '').trim();
  const ctx      = (req.query.ctx || '').trim();
  if (question.length < 2) return res.status(400).json({ error: 'query too short' });
  if (!ANTHROPIC_API_KEY) {
    console.error('[/api/ask] ANTHROPIC_API_KEY not set');
    return res.status(503).json({ error: 'Search not configured — ANTHROPIC_API_KEY missing' });
  }

  try {
    const intent = detectQueryIntent(question);
    let contextBlock = '', sources = [], sourceLabel = 'the knowledge base';

    if (intent === 'sprint') {
      const sprintCtx = await fetchSprintContext(question);
      if (sprintCtx) {
        const agentNote = sprintCtx.agentFilter ? ` for ${sprintCtx.agentFilter}` : '';
        contextBlock = `Sprint board data (${sprintCtx.total} cards${agentNote}):\n\n${sprintCtx.summary}`;
        sourceLabel = 'the sprint board';
        sources = [{ name: 'Sprint Board (live)', path: 'api.integratedai.com.au/sprint' }];

        // Augment with most recent session intel for the detected agent
        // so Base can explain what the cards actually mean in context
        if (sprintCtx.agentFilter) {
          const sessionPaths = [
            'kb/00-foundations/session-intel',
            'kb/00-foundations/Session Intel',
          ];
          const sessionFiles = await fetchKBFilesForSearch(sessionPaths, sprintCtx.agentFilter);
          const sessionContext = await buildSearchContext(sessionFiles.slice(0, 2));
          if (sessionContext.length) {
            contextBlock += '\n\n--- Session intel (most recent for ' + sprintCtx.agentFilter + ') ---\n' +
              sessionContext.map(c => `FILE: ${c.path}\n${c.text}`).join('\n\n');
            sources.push(...sessionContext.map(c => ({ name: c.name, path: c.path })));
          }
        }
      }
    } else if (intent === 'pursuit') {
      const pursuitCtx = await fetchPursuitContext(question);
      if (pursuitCtx) {
        contextBlock = `Pursuit data:\n\n${pursuitCtx.summary}`;
        sourceLabel = pursuitCtx.code ? `the ${pursuitCtx.code} pursuit` : 'the pursuits database';
        sources = [{ name: `Pursuits${pursuitCtx.code ? ' — ' + pursuitCtx.code : ''} (live)`, path: 'api.integratedai.com.au/pursuits' }];
      }
    }

    // Fall back to KB if live sources returned nothing
    if (!contextBlock) {
      const { paths, agentFilter } = routeQuestion(question);
      const files   = await fetchKBFilesForSearch(paths, agentFilter);
      const context = await buildSearchContext(files);
      if (!context.length) {
        return res.json({
          answer: 'Nothing relevant found for that question. Try rephrasing with an agent name, project name, or topic.',
          sources: [],
          intent: intent || 'kb',
        });
      }
      contextBlock = context.map(c => `--- FILE: ${c.path} ---\n${c.text}`).join('\n\n');
      sources = context.map(c => ({ name: c.name, path: c.path }));
      sourceLabel = 'the knowledge base';
    }

    const systemPrompt = [
      'You are Base, the IAI internal knowledge interface.',
      'You answer questions about how Integrated AI (IAI) works — its agents, decisions, projects, and operating protocols.',
      'You draw from live sprint board data, the pursuits database, and the IAI knowledge base depending on what the question needs.',
      '',
      'Rules:',
      '- Answer directly and concisely. No preamble, no filler.',
      '- Australian English. No em dashes. Use commas, colons, or new sentences instead.',
      `- When answering from live data, begin with "From ${sourceLabel}:" to signal the source.`,
      '- Cite which KB files you drew from by filename (not full path) at the end of your answer, when answering from the KB.',
      '- If the answer is partial or uncertain, say so clearly.',
      '- If the user says "yes" or gives a short affirmative, check the conversation context to understand what they are confirming and respond accordingly.',
      '- End with a brief offer to surface a specific file if useful: "Want me to pull up [filename]?" Only include this when answering from the KB and there is something genuinely worth surfacing.',
      '- If nothing in the provided data answers the question, say so directly. Do not fabricate.',
    ].join('\n');

    const ctxSection  = ctx ? `Conversation so far:\n${ctx}\n\n---\n\n` : '';
    const userMessage = `Data retrieved:\n\n${contextBlock}\n\n---\n\n${ctxSection}Question: ${question}`;

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

    // Trim sources to only files actually mentioned in the answer — avoids
    // surfacing the full fetch context when only 1-2 files were cited
    const citedSources = sources.filter(s => answer.includes(s.name));
    const finalSources = citedSources.length > 0 ? citedSources : sources.slice(0, 3);

    return res.json({ answer, sources: finalSources, intent });

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

// Image Library
app.get('/images', (_req, res) => res.sendFile(path.join(__dirname, 'images.html')));

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
