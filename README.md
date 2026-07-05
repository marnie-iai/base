# Base

IAI's internal knowledge layer, live at base.integratedai.com.au. Base is the
window onto everything IAI knows and is doing: it answers questions, browses
the KB, shows the agent roster and pursuit constellations, renders documents,
and hosts the campaign dashboards.

Base is one of three systems and must not blur into the others:

- **Base** is the platform, the operating layer. It stores nothing of its own
  (one Turso table for agent session context aside); everything it shows is
  fetched live from other systems.
- **KB** (marnie-iai/kb) is what IAI knows and produces: briefs, decisions,
  brand, session intel, published work.
- **Vault** is what IAI learns from outside: external intelligence only.

## Architecture at a glance

One Node/Express server (`server.js`, no framework, no build step) serving a
handful of static HTML pages, each self-contained with inline CSS and JS. The
server is a thin authenticated proxy in front of five live sources:

| Source | Used for | Auth |
|---|---|---|
| GitHub: marnie-iai/kb (private) | KB directory listings, raw files, code search, file commit dates | `GITHUB_PAT` |
| GitHub: marnie-iai/agent-portraits (public) | Agent headshots | none |
| Grid API (api.integratedai.com.au) | Pursuits registry, live sprint board (Ask) | none |
| Anthropic API | `/api/ask` answer synthesis | `ANTHROPIC_API_KEY` |
| Turso (libsql) | `agent_context` table (agent session context store) | `TURSO_URL` + `TURSO_AUTH_TOKEN` |
| Google Sheets API | Index completions summary for dashboards | `SHEETS_API_KEY` |

Responses are cached in an in-process `Map` (5, 10 or 60 minute TTLs
depending on endpoint). There is no database of Base's own beyond the
`agent_context` table; restart the process and the cache is simply cold.

Auth is HTTP Basic, password-only (the username is ignored): `SITE_AUTH`
protects the whole site, `DASHBOARD_AUTH` adds a second gate on
`/dashboards`. **Both are no-ops if unset**, so `SITE_AUTH` must be set in
production or the site, and the KB behind it, is open to the internet.

## Pages

| Route | File | What it shows |
|---|---|---|
| `/` | `index.html` | The hub: hero with the Ask bar (conversational KB + live-data search), four nav tiles (Pursuits, Dashboards, Agents, Image Library) with live counts, and a KB file search below the tiles |
| `/agents` | `agents.html` | Agent roster grouped by point (Business, Workshop, Family, Operating Protocols, Resource, Foundations), portrait cards with status badges. **Route currently unrouted, see Known issues** |
| `/agent/:slug` | `agent.html` | One agent's constellation: portrait, role, reports-to, identity (prompt docs), briefs, pursuit memberships, related agents |
| `/pursuits` | `pursuits.html` | Pursuit index from the Grid API, filterable by status |
| `/pursuits/:code` | `pursuit-detail.html` | One pursuit: status, client, dates, board link, constellation members |
| `/read?path=...` | `read.html` | In-app document reader: markdown rendered with register-aware typography, breadcrumb, last-updated date, download, prev/next within the folder |
| `/view?path=...` | (server-rendered) | Full-page HTML KB files with the Base nav bar injected at the top |
| `/images` | `images.html` | Image library: masonry grid of KB images filtered by point. **Route currently unrouted, see Known issues** |
| `/dashboards` | `dashboards/index.html` | Dashboard index (second password) linking to the four live dashboards |
| `/dashboards/Index` | `dashboards/index-analytics.html` | Industrial AI Index analytics |
| `/dashboards/clear-ground` | `dashboards/clear-ground.html` | Clear Ground campaign dashboard (GA4 funnel) |
| `/dashboards/clear-ground-metrics` | `dashboards/clear-ground-metrics.html` | Clear Ground campaign KPIs |
| `/dashboards/iai-website` | `dashboards/iai-website.html` | IAI website analytics |

Any unmatched GET falls through to `index.html` (catch-all). `manifest.json`
and the two icons are served before auth so the PWA can install.

### API endpoints (all behind `SITE_AUTH` unless noted)

- `GET /api/ask?q=...&ctx=...` conversational search: routes the question to
  KB folders by keyword, optionally pulls live sprint/pursuit data from the
  Grid API, synthesises an answer via the Anthropic API, returns
  `{answer, sources, live}`.
- `GET /api/kb?path=...` KB directory listing. `GET /api/raw?path=...` raw
  file proxy (the KB repo is private, so images and files stream through
  here). `GET /api/search?q=...` GitHub code search over the KB.
  `GET /api/filemeta?path=...` last-commit date for a file.
- `GET /api/roster` the agent roster, parsed at request time from the KB
  roster markdown. `GET /api/agent/:slug` one agent's assembled
  constellation data. `GET /api/portraits` portrait file list.
- `GET /api/pursuits` and `GET /api/pursuits/:code` proxied from the Grid API.
- `GET /api/agent-context/:agent_id` and `POST /api/agent-context` the agent
  session-context store (Turso). Bearer-authed with `AGENT_API_KEY`, sits
  **before** site auth so agents can call it without the Basic password.
- `GET /api/public/completions/summary` public (CORS `*`, before site auth):
  Index completion counts by sector from Google Sheets.
- `GET /api/debug` GitHub PAT diagnostic (behind site auth).

## Environment variables

All optional in code, but the first two rows are effectively mandatory in
production. Names verified against `server.js`.

| Variable | Purpose | Behaviour if unset |
|---|---|---|
| `SITE_AUTH` | Basic-auth password for the whole site | **Site is open.** Logs a warning per request. Must be set in production |
| `GITHUB_PAT` | PAT with read access to private marnie-iai/kb (contents + code search) | KB endpoints return empty results |
| `DASHBOARD_AUTH` | Second Basic-auth password on `/dashboards` | Dashboards gated by site auth only |
| `ANTHROPIC_API_KEY` | `/api/ask` synthesis | `/api/ask` returns 503 |
| `TURSO_URL` | libsql URL for the agent-context DB | Agent-context endpoints return 503 |
| `TURSO_AUTH_TOKEN` | Turso auth token | As above |
| `AGENT_API_KEY` | Bearer token for the agent-context endpoints | Agent-context endpoints return 503 |
| `SHEETS_API_KEY` | Google Sheets API key for the completions summary | Endpoint returns `sheets_not_configured` |
| `SHEETS_SPREADSHEET_ID` | Spreadsheet ID for the completions summary | As above |
| `PORT` | Listen port | Defaults to 8080 |

## Run locally

```bash
npm install
GITHUB_PAT=... SITE_AUTH=... npm start
# http://localhost:8080  (any username, password = SITE_AUTH)
```

With only `GITHUB_PAT` set you get the hub, KB browsing, reader, agents and
images. Add `ANTHROPIC_API_KEY` for Ask, nothing extra for pursuits (the Grid
API is public-read from the server side).

## Deploy

Railway, auto-built with Nixpacks (`nixpacks.toml`: `npm install` then
`npm start`). Set the env vars in the Railway service. `nginx.conf` is a
leftover from an earlier static-hosting setup and is not used by the Node
server. Canonical URL: base.integratedai.com.au.

## Known issues

- **Routes dropped by regression**: commit `43e3bfd` removed the explicit
  `/agents`, `/images` and `/sw.js` routes from `server.js`, so those URLs
  currently fall through the catch-all and re-serve the hub. `agents.html`
  and `images.html` are complete pages awaiting their one-line routes back;
  the service worker cannot register while `/sw.js` serves HTML.
- **Client-side Google API key**: four dashboard pages embed a Google Sheets
  API key in their inline JS. See the Security section in CLAUDE.md; the key
  must be rotated and the reads moved server-side.

## Documentation

- `CLAUDE.md` dev context for agent sessions (conventions, data flow,
  maintenance points, security).
- `docs/guides/` user guides for every Base surface.
