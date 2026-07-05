# CLAUDE.md - Base (base.integratedai.com.au)

Dev context for working on this repo. Read before writing code. README.md has
the page map and env var table; this file covers what an agent session needs
to change things safely.

## What this is

Base is IAI's internal knowledge layer: the platform/operating window onto
the KB, the Grid API, and the dashboards. It is one of three systems: Base is
the platform, KB (marnie-iai/kb) is what IAI knows and produces, Vault is
external intelligence. Do not blur them: Base stores no content of its own.

## Repo structure

```
base/
├── server.js              Everything server-side: auth, cache, GitHub/Grid/
│                          Anthropic/Turso/Sheets proxies, page routes (~1020 lines)
├── index.html             Hub: Ask bar, nav tiles, KB file search
├── agents.html            Roster grid (route currently missing, see defects)
├── agent.html             Single-agent constellation page (/agent/:slug)
├── pursuits.html          Pursuit index (/pursuits)
├── pursuit-detail.html    Single pursuit (/pursuits/:code)
├── read.html              Markdown document reader (/read?path=...)
├── images.html            Image library (route currently missing, see defects)
├── dashboards/            Static dashboard pages, extra Basic-auth gate
├── manifest.json + icons  PWA install assets (served before auth)
├── sw.js                  Service worker (route currently missing, see defects)
├── nixpacks.toml          Railway build (npm install / npm start)
└── nginx.conf             Legacy leftover, NOT used by the Node server
```

No framework, no bundler, no build step. Each HTML page is self-contained
(inline CSS + JS). `package.json` deps: express and @libsql/client only.

## Where data comes from

Nothing is local. Every page fetches through `server.js`, which proxies live:

- **KB content**: GitHub contents API + raw.githubusercontent.com for the
  private marnie-iai/kb repo, authed with `GITHUB_PAT`. Directory listings
  via `/api/kb`, files via `/api/raw`, code search via `/api/search`,
  last-commit dates via `/api/filemeta`.
- **Roster**: parsed at request time from the KB roster markdown. The file
  path is the `ROSTER_FILE` constant in server.js (currently
  `kb/00-foundations/00_Agent_Roster_v2_2_Apr2026.md`). `parseRoster()` reads
  H2 headings for chiefs (`Chief of X - Name`) and table rows for the rest,
  with a hard-coded `POINT_BY_CHIEF` map (reid/sable/neve/maren/sterling).
  **When a new roster version is filed to the KB, `ROSTER_FILE` must be
  bumped by hand or Base keeps parsing the old file.**
- **Pursuits + sprint board**: proxied from the Grid API
  (api.integratedai.com.au), no auth.
- **Ask**: `/api/ask` routes the question to KB folders via three keyword
  tables in server.js (`AGENT_KB_PATHS`, `ENTITY_KB_PATHS`,
  `STRUCTURAL_KB_PATHS`), caps at 7 paths / 12 files / 80k chars, detects
  live-data needs (`SPRINT_TRIGGER_WORDS`, `PURSUIT_TRIGGER_WORDS`,
  `PURSUIT_CODES`) and pulls the Grid sprint board or pursuits, then
  synthesises with the Anthropic API. These tables are the search index:
  a new agent, client or project is invisible to Ask until added here.
- **Agent context**: one Turso table (`agent_context`), created idempotently
  at startup. Bearer-authed endpoints, mounted BEFORE site auth.
- **Sheets**: `/api/public/completions/summary` reads the Index completions
  sheet server-side with `SHEETS_API_KEY`.

## Caching

In-process `Map` in server.js, key -> `{data, ts, ttl}`:

- 5 min (`TTL_5M`, default): KB directory listings, code search, portraits,
  assembled agent pages, pursuits list and detail.
- 10 min (`TTL_10M`): roster, public completions summary.
- 60 min (`TTL_60M`): file commit dates (`/api/filemeta`).
- HTTP `Cache-Control: max-age=300` on `/api/raw` and `/view` responses;
  `max-age=600` on the public completions endpoint.
- Client side: pages memoise `/api/kb` results per page load only.

Practical effect: KB edits appear within 5 minutes, roster edits within 10.
A restart clears everything (no persistence).

## Hard-coded path arrays (update when KB folders change)

The KB browse and image surfaces do NOT walk the repo tree; they fetch a
fixed list of folders. When a KB folder is added, renamed or removed, update:

- `index.html` -> `ALL_KB_PATHS` (~line 1124) plus the explicit `fetchKB(...)`
  lists inside the `loadFoundations`/`loadBusiness`/etc section loaders.
- `images.html` -> `ALL_KB_PATHS` (~line 153), including the Drive-synced
  `kb/images/*` folders.
- `server.js` -> the three Ask routing tables (`AGENT_KB_PATHS`,
  `ENTITY_KB_PATHS`, `STRUCTURAL_KB_PATHS`) and `PURSUIT_CODES`.
- `dashboards/index.html` and `dashboards/landing.html` -> the dashboard card
  list (a new dashboard needs a card in both, a server route, and nothing else).

A missing path fails silently (empty result), so a renamed KB folder just
quietly disappears from Base. Check these arrays first when "files are
missing".

Note: `index.html` still carries the section-loader code
(`loadFoundations` ... `loadResource`) from the pre-tile homepage, but the
matching `sec-*` elements are no longer in the DOM, so only `ALL_KB_PATHS`
(used by `loadImages`) is live there today. Do not build on the section
loaders without re-adding their DOM.

## Conventions

- Australian English. No em dashes in any output, code comments included.
- Conventional Commits: `type(scope): subject`.
- Prefer editing existing files over adding new ones. New pages need a
  server.js route (see defect below for what happens when routes go missing).
- No client-specific or aspirational logic; Base shows what the sources hold.
- Never commit .env files or secrets. All keys live in Railway env vars.
- Docs ship with the change: update README.md, this file, and `docs/guides/`
  in the same PR as any behaviour change.

## SECURITY

- **`SITE_AUTH` must be set in production.** `requireSiteAuth` is a NO-OP
  when the var is unset (it warns and calls `next()`), which leaves the
  whole site, and the private KB proxied behind it, open to the internet.
  Same pattern for `DASHBOARD_AUTH` on `/dashboards`. Treat "auth env var
  unset" as an outage-severity misconfiguration, not a default.
- Auth compares the Basic password only (username ignored) and is not
  timing-safe; acceptable for an internal gate, not a pattern to extend.
- **Never embed API keys client-side.** Server-side keys (`GITHUB_PAT`,
  `ANTHROPIC_API_KEY`, `TURSO_AUTH_TOKEN`, `AGENT_API_KEY`,
  `SHEETS_API_KEY`) must only ever be read from `process.env` in server.js
  and never appear in HTML, inline JS, or logs.
- **KNOWN DEFECT (fix + rotate)**: a Google Sheets API key is currently
  embedded in the inline JS of four dashboard pages
  (`dashboards/clear-ground.html`, `dashboards/clear-ground-metrics.html`,
  `dashboards/iai-website.html`, `dashboards/clear-ground-campaign.html`,
  each in a `CONFIG.API_KEY` field; only clear-ground-campaign actually uses
  it in a request, the others fetch via the public gviz CSV export). The fix
  is: remove the key from all four files, move any keyed Sheets read behind
  a server.js endpoint (the `/api/public/completions/summary` pattern), and
  rotate the key in Google Cloud since it has shipped to browsers. Do not
  copy the key value into any doc, commit message, or chat output.
- The agent-context endpoints sit before site auth by design (agents call
  them with the `AGENT_API_KEY` bearer, no Basic password). Anything else
  added above `app.use(requireSiteAuth)` in server.js is publicly reachable;
  add routes there only deliberately.
- `/api/raw` and `/view` proxy any path in the KB repo to an authed user.
  That is the point of Base, but remember the KB is private for a reason:
  Base's password is the KB's password.

## Known defects (current)

1. **Missing routes regression**: commit `43e3bfd` rewrote server.js and
   dropped `app.get('/agents')`, `app.get('/images')` and `app.get('/sw.js')`.
   Those URLs now hit the catch-all and serve `index.html`: the roster and
   image library pages are unreachable and the service worker cannot
   register (it receives HTML). Fix is re-adding the three sendFile routes
   above the catch-all.
2. **Client-side Sheets key** (see SECURITY above).
3. `dashboards/index.html` and `dashboards/landing.html` are near-duplicate
   card lists; `/dashboards` serves index.html, landing.html is only
   reachable via the static fallback. Consolidate when next touched.

## Deploy

Railway, Nixpacks build, auto-deploy on push to main. No staging environment:
test locally (`GITHUB_PAT=... SITE_AUTH=... npm start`) before merging.
