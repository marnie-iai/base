'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const GITHUB_PAT = process.env.GITHUB_PAT;
const KB_REPO = 'marnie-iai/kb';
const PORTRAITS_REPO = 'marnie-iai/agent-portraits';
const PORTRAITS_RAW = `https://raw.githubusercontent.com/${PORTRAITS_REPO}/main/portraits/`;
const ROSTER_FILE = 'kb/00-foundations/00_Agent_Roster_v2_2_Apr2026.md';

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

    // ── H2 section ──────────────────────────────────────────────────────────
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

    // ── Table row ────────────────────────────────────────────────────────────
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
    const result = data || { items: [] };
    cacheSet(key, result);
    return res.json(result);
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

// Agent roster — full parsed list
app.get('/api/roster', async (_req, res) => {
  try {
    const agents = await getRoster();
    return res.json(agents);
  } catch {
    return res.json([]);
  }
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

    // Portrait URL (public repo) — Name_headshot.png
    const portraitUrl = `${PORTRAITS_RAW}${agent.name}_headshot.png`;

    // Identity — prompt docs matching this slug
    const agentDocs = await fetchKBDir('kb/00-foundations/agents');
    const identity = agentDocs
      .filter(f => f.name.toLowerCase().includes(`prompt-${slug}`))
      .sort((a, b) => b.name.localeCompare(a.name));

    // Briefs — search for agent name in KB, filter for brief-like files
    const searchResults = await searchKB(agent.name);
    const briefs = searchResults.filter(f => {
      const n = f.name.toLowerCase();
      const p = f.path.toLowerCase();
      if (p.includes('/agents/')) return false; // already in identity
      return /brief|handover|devspec|devbrief|spec|induction/.test(n);
    }).slice(0, 12);

    // Related agents — same point + direct reports chain
    const related = roster.filter(a =>
      a.slug !== slug && !['petra'].includes(a.slug) && (
        a.point === agent.point ||
        a.slug === agent.reportsTo ||
        a.reportsTo === slug
      )
    ).slice(0, 8);

    // Reports-to name lookup
    const reportsToAgent = agent.reportsTo ? roster.find(a => a.slug === agent.reportsTo) : null;

    const result = {
      ...agent,
      portraitUrl,
      reportsToName: reportsToAgent ? reportsToAgent.name : null,
      identity: identity.map(f => ({
        name: f.name, path: f.path,
        url: `https://github.com/${KB_REPO}/blob/main/${f.path}`,
      })),
      briefs: briefs.map(f => ({
        name: f.name, path: f.path,
        url: `https://github.com/${KB_REPO}/blob/main/${f.path}`,
      })),
      related: related.map(a => ({
        name: a.name, slug: a.slug, role: a.role, point: a.point, status: a.status,
      })),
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

// Diagnostic
app.get('/api/debug', async (_req, res) => {
  const testUrl = `https://api.github.com/repos/${KB_REPO}/contents/kb/00-foundations`;
  const headers = { 'User-Agent': 'IAI-Base/3.0', 'Accept': 'application/vnd.github.v3+json' };
  if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  try {
    const r = await fetch(testUrl, { headers });
    const text = await r.text();
    return res.json({
      patSet: !!GITHUB_PAT, patPrefix: GITHUB_PAT ? GITHUB_PAT.slice(0, 10) + '…' : null,
      githubStatus: r.status, githubStatusText: r.statusText,
      responsePreview: text.slice(0, 300),
    });
  } catch (err) {
    return res.json({ patSet: !!GITHUB_PAT, fetchError: err.message });
  }
});

// In-app document reader
app.get('/read', (_req, res) => {
  res.sendFile(path.join(__dirname, 'read.html'));
});

// Agent constellation page
app.get('/agent/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'agent.html'));
});

// Main intranet — catch-all
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Base listening on :${PORT}`);
  if (!GITHUB_PAT) console.warn('[!] GITHUB_PAT not set — KB endpoints will return empty results');
});
