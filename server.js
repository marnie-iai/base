'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const GITHUB_PAT = process.env.GITHUB_PAT;
const KB_REPO = 'marnie-iai/kb';
const PORTRAITS_REPO = 'marnie-iai/agent-portraits';

// ── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── GitHub fetch helper ───────────────────────────────────────────────────────
async function ghFetch(url, auth = true) {
  const headers = {
    'User-Agent': 'IAI-Base/3.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (auth && GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`[ghFetch] ${res.status} ${res.statusText} — ${url}`);
    return null;
  }
  return res.json();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// KB directory listing — private repo, requires PAT
app.get('/api/kb', async (req, res) => {
  const kbPath = req.query.path;
  if (!kbPath) return res.status(400).json({ error: 'Missing path param' });

  const key = `kb:${kbPath}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.github.com/repos/${KB_REPO}/contents/${kbPath}`;
    const data = await ghFetch(url, true);
    const result = data || [];
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/kb]', err.message);
    return res.json([]);
  }
});

// KB code search — private repo, requires PAT
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.trim().length < 2) return res.json({ items: [] });

  const key = `search:${q.trim().toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return res.json(cached);

  try {
    const encoded = encodeURIComponent(q.trim());
    const url = `https://api.github.com/search/code?q=${encoded}+repo:${KB_REPO}&per_page=30`;
    const data = await ghFetch(url, true);
    const result = data || { items: [] };
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/search]', err.message);
    return res.json({ items: [] });
  }
});

// Agent portraits — public repo, no auth needed
app.get('/api/portraits', async (req, res) => {
  const key = 'portraits';
  const cached = cacheGet(key);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.github.com/repos/${PORTRAITS_REPO}/contents/portraits`;
    const data = await ghFetch(url, false);
    const result = data || [];
    cacheSet(key, result);
    return res.json(result);
  } catch (err) {
    console.error('[GET /api/portraits]', err.message);
    return res.json([]);
  }
});

// Diagnostic endpoint — confirms PAT is set and shows GitHub API status
app.get('/api/debug', async (_req, res) => {
  const testUrl = `https://api.github.com/repos/${KB_REPO}/contents/kb/00-foundations`;
  const headers = {
    'User-Agent': 'IAI-Base/3.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  try {
    const r = await fetch(testUrl, { headers });
    const text = await r.text();
    return res.json({
      patSet: !!GITHUB_PAT,
      patPrefix: GITHUB_PAT ? GITHUB_PAT.slice(0, 10) + '…' : null,
      githubStatus: r.status,
      githubStatusText: r.statusText,
      responsePreview: text.slice(0, 300),
    });
  } catch (err) {
    return res.json({ patSet: !!GITHUB_PAT, fetchError: err.message });
  }
});

// Serve index.html for all other routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Base listening on :${PORT}`);
  if (!GITHUB_PAT) console.warn('[!] GITHUB_PAT not set — KB endpoints will return empty results');
});
