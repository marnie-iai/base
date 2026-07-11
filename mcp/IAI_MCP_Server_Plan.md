# iai-ops-mcp — Implementation Plan

## 1. What this is

A TypeScript MCP server that wraps IAI's own private APIs, currently only reachable
through hand-rolled Python (`grid.py` in the grid-board-ops skill) and raw curl
(fenn-handover skill). Once built, any agent (Reid, Morgan, Harlow, Lumen, Sterling,
Mirror, Arna, Cowork sessions, Claude Code) gets typed, verified tool calls instead of
shell-script or copy-pasted curl, and the trap-handling logic that currently lives only
in your head and in `grid.py`'s comments gets baked into the schema and the error
messages themselves.

Three APIs, three domains of tools:

1. **Sprint board** (`api.integratedai.com.au`) — read/create/update/verify cards
   across the main board and every pursuit board.
2. **Fenn debrief** (`iops.integratedai.com.au`) — post a session-close debrief as a
   pending record for Marnie to walk through in iOps.
3. **Agent context store** (`base.integratedai.com.au`, DEV-010) — read/write
   structured per-agent context, gated because it may not be live yet.

Everything else these skills touch (KB commits, Drive Inbox) already has a working MCP
connector (`Clio-KB-MCP` / Google Drive) — out of scope here.

---

## 2. Decisions confirmed with Marnie

| # | Issue | Resolution |
|---|---|---|
| 1 | **Pursuit code list** | Union both lists: `io, eng, iv, pc, main, hif, hed, hma, ws`. Codes are validated against this known set for a helpful error, but an unrecognised code is still attempted (404 confirms it's genuinely wrong) rather than hard-blocked — the list will drift as pursuits open and close. |
| 2 | **PATCH endpoint shape** | Build to `grid.py`'s proven behaviour: one `PATCH /{code}/sprint/{id}` (or `/sprint/{id}` for main) carrying all changed fields, not a separate `/status` sub-route. |
| 3 | **Board API auth** | **Google sign-in**, not a static bearer token — see section 4. Confirmed: login as `marnie@integratedcoatingservices.com`. |
| 4 | **`/sprint/ageing`** | No sample response available yet. Building the tool defensively (tolerant parsing, clear error if the shape doesn't match) and validating on first live call together. |
| 5 | **DEV-010 agent context store** | Marked experimental at build time (Marnie: "not live yet"). **Update after inspecting `marnie-iai/base`'s own README (section 12): the code is real and deployed** — `base.integratedai.com.au` hosts `GET/POST /api/agent-context` itself, Turso-backed, bearer-authed with `AGENT_API_KEY` — the exact env var name this server already uses. "Not live" most likely means `TURSO_URL`/`TURSO_AUTH_TOKEN`/`AGENT_API_KEY` aren't yet set in Railway, not that the feature doesn't exist. Kept the soft-fail behaviour regardless — costs nothing and covers both cases. |
| 6 | **Default agent identity** | Keep `alex` as the default `agent` field on writes (matches "the board is Alex-held"), overridable per call for the rare case another agent's identity is needed. |

---

## 3. Architecture

- **Name:** `iai-ops-mcp` (Node/TypeScript naming convention: `{service}-mcp-server`
  would give `iai-mcp-server`; using `iai-ops-mcp` to distinguish from a possible future
  `iai-kb-mcp` etc. — happy to rename).
- **Language:** TypeScript, `@modelcontextprotocol/sdk`, Zod for validation.
- **Transport:** **stdio**, matching how `grid.py` and the curl calls run today — one
  process per session, secrets from that session's environment, no hosting to stand up.
  If you later want this shared across a fleet of always-on agents rather than
  per-session, it can be re-pointed at Streamable HTTP with almost no tool-code changes
  — flagging as a future option, not building it now.
- **Project structure:**

```
iai-ops-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts              # server init, transport selection
│   ├── types.ts              # Card, Debrief, AgentContext interfaces
│   ├── constants.ts          # API base URLs, CHARACTER_LIMIT, CLOSED_STATUSES
│   ├── services/
│   │   ├── boardClient.ts    # sprint board HTTP client + trap handling
│   │   ├── debriefClient.ts  # Fenn debrief HTTP client
│   │   └── contextClient.ts  # agent context store HTTP client
│   ├── schemas/
│   │   ├── board.ts          # Zod schemas for board tools
│   │   ├── debrief.ts
│   │   └── context.ts
│   └── tools/
│       ├── board.ts          # registerTool calls for board domain
│       ├── debrief.ts
│       └── context.ts
```

---

## 4. Auth & configuration

### Board API — Google sign-in (new)

The board API currently accepts no auth at all; the target state is Google OAuth as
`marnie@integratedcoatingservices.com`. You mentioned OAuth clients already exist for
iOps and Engage and "possibly others" but weren't sure about the board API
specifically — first implementation step is confirming with Dev/Alex whether a Desktop
app OAuth client already covers `api.integratedai.com.au`, or whether one needs
registering in Google Cloud Console alongside the existing ones.

Design (standard CLI/installed-app pattern, same shape as `gcloud`/`gh auth login`):

1. **First use**: no cached token found → server opens the system browser to Google's
   OAuth consent screen (Authorization Code + PKCE flow, no client secret needed to
   ship in the binary).
2. Marnie signs in as `marnie@integratedcoatingservices.com`, consents once.
3. Server receives the auth code on a local loopback redirect, exchanges it for an
   access token + **refresh token**.
4. **Refresh token is cached locally** (e.g. `~/.config/iai-ops-mcp/token.json`, file
   permissions locked to the user) — confirmed you want this so future sessions don't
   need a repeat login.
5. Every board API call attaches `Authorization: Bearer <access_token>`; the client
   transparently refreshes when the access token is near expiry.
6. New tool: `iai_board_login` — explicit re-auth if the cached token is revoked or
   expired past refresh, surfaced as a clear error from any board tool telling the
   agent to call it.

This is the one piece of section 5's tool catalogue that changes: add `iai_board_login`
to the board domain table, not idempotent, opens a browser (so it cannot run inside a
fully headless environment without a fallback — flagging that as a real constraint for
server contexts with no display; device-code flow is the fallback there and I'll build
it if this ever needs to run somewhere headless).

### Other tokens

| Var | Used by | Required |
|---|---|---|
| `IOPS_DEBRIEF_TOKEN` | Fenn debrief client | Required for `iai_send_fenn_debrief` |
| `AGENT_API_KEY` | Agent context client | Required for the two `iai_*_agent_context` tools; if unset, those tools return a clear "not configured" error rather than crashing the server |
| `IAI_DEFAULT_AGENT` | Board writes | Optional, defaults to `alex` |
| `IAI_BOARD_OAUTH_CLIENT_ID` | Board OAuth flow | Required once the Google client is confirmed/created |

Secrets and cached tokens are never logged, never echoed back in tool output — matching
the "never print it" rule already in the fenn-handover skill.

---

## 5. Tool catalogue

Naming convention: `iai_{action}_{resource}`, snake_case, all read tools marked
`readOnlyHint: true`, all writes `destructiveHint: true`.

### Board domain

| Tool | Purpose | Key inputs | Annotations |
|---|---|---|---|
| `iai_list_boards` | Static reference: valid pursuit codes and their endpoints, so an agent never guesses `iops`/`engage` | none | readOnly, idempotent |
| `iai_read_board` | Fetch a board's cards, filtered client-side (server-side `?owner=` is documented as unreliable, so the client always fetches the full board and filters in code) | `board` (string, validated against `iai_list_boards`' list with a helpful 404 message if wrong), `status`, `owner`, `include_closed` (bool, default false), `response_format` | readOnly, idempotent |
| `iai_get_card` | Fetch one card by `cardId` (e.g. `IO-038`) or numeric id | `board`, `ref` | readOnly, idempotent |
| `iai_create_card` | POST a new card | `board`, `title`, `description`, `owner`, `domain`, `status`, `priority?`, `dependsOn?` (accepts cardIds or ints, resolved to ints), `briefRef?`, `referenceUrl?`, `filedPath?`, `outputPath?`, `marnieAction?`, `sessionNotes?`, `agent?` | destructive, not idempotent |
| `iai_update_card` | PATCH a card by `cardId` or numeric id, then **re-query to verify** the field that was set actually stuck (ports `grid.py`'s verify-after-patch, including the 600 ms settle delay) | `board`, `ref`, any subset of the create fields, `agent?` | destructive, not idempotent (session notes append) |
| `iai_verify_card` | Re-query and confirm one or more fields match expected values — exposed standalone for the "write didn't verify, check again" case | `board`, `ref`, `expected` (field/value map) | readOnly, idempotent |
| `iai_list_ageing_backlog` | GET the Monday ageing/backlog view (unverified endpoint — built defensively, see open question #4) | `board?` | readOnly, idempotent |

**Trap handling ported directly from `grid.py`, not reinvented:**
- Pursuit code validated against the known list before any request; a wrong code gets
  "did you mean `io`, not `iops`?"-style guidance instead of a bare 404.
- `dependsOn` accepts `["IO-020"]` or `[20]` interchangeably; always resolved to an
  integer array before the request goes out.
- `sessionNotes` — if the input string looks like it starts with a date (`^\[?\d{1,2}\s?\w{3}`
  or similar), the tool description and a runtime warning tell the agent the API
  auto-timestamps notes and a manual date prefix will double up.
- Every write re-queries the card and confirms the changed field(s) hold before
  returning `ok: true`; `ok: false` comes back with "the write did not verify — retry
  once before assuming it landed," not a silent success.
- Board responses parsed for both `cards` and `tasks` keys.

### Debrief domain

| Tool | Purpose | Key inputs | Annotations |
|---|---|---|---|
| `iai_send_fenn_debrief` | POST a session-close debrief to Fenn as a **pending** record | `job`, `date?` (defaults to today, ISO, AEST), `hours` (0–24), `summary_internal`, `summary_client?`, `actions?` (array of `{fn, ...args}` restricted to the six documented functions) | destructive, not idempotent |

The tool description carries the confirm-first rule verbatim: *"This creates a pending
debrief only — nothing is logged or published until a human confirms it in iOps. Only
call this after the user has explicitly approved the payload shown to them."* That's a
description-level instruction for the calling agent, not something the server can
enforce — the actual gate stays in the skill/agent behaviour layer, same as today.

Specific error handling ported from the skill: `401` → bad token; `503` → token not
configured server-side; `409 fenn_debriefs_migration_pending` → tell the user migration
0049 hasn't run. No more than two automatic retries, matching the existing rule.

### Agent context domain (experimental — DEV-010)

| Tool | Purpose | Key inputs | Annotations |
|---|---|---|---|
| `iai_get_agent_context` | GET the last N context records for an agent | `agent_id`, `limit?` (default 3) | readOnly, idempotent |
| `iai_post_agent_context` | POST a structured context summary for an agent | `agent`, `session_date`, `context_json` (week, work_completed[], decisions_made[], open_items[], flags[], carry_forward) | destructive, not idempotent |

Both tools catch connection/404/503 failures and return a soft "context store not
available — proceeding without it" result rather than throwing, matching the "don't
block the session" instruction in both session-ritual skills. Descriptions state
plainly that this endpoint may not be live yet.

---

## 6. Response format & pagination

Every list-returning tool (`iai_read_board`, `iai_list_ageing_backlog`,
`iai_get_agent_context`) supports `response_format: "markdown" | "json"` (markdown
default, matching the existing CLI's compact table style) and truncates against a
`CHARACTER_LIMIT` (25,000 chars) with a clear truncation message and a suggestion to
narrow with `status`/`owner` filters — boards are small enough that true cursor
pagination is unlikely to be needed, but the truncation guard costs nothing.

---

## 7. Security notes

- Board API currently has no auth on the client side (see open question #3) — worth a
  deliberate decision, not an oversight carried forward silently.
- All three tokens live only in `process.env`, read per-call, never included in tool
  output, never logged to stdout (stdio servers log to stderr only, per MCP best
  practice).
- `iai_send_fenn_debrief` and the card-write tools are marked `destructiveHint: true` so
  any client-side confirmation UI treats them accordingly.

---

## 8. Testing plan

1. `npm run build` clean, `node dist/index.js` boots without error.
2. MCP Inspector (`npx @modelcontextprotocol/inspector`) against stdio transport —
   exercise each tool manually, including deliberately wrong pursuit codes and
   cardId-vs-numeric-id mixups, to confirm the guardrail messages actually fire.
3. One real read-only pass against the live `io` board with you present, to settle open
   questions #1–#4 against actual responses rather than the skill docs' text.
4. One real write (create + patch + verify) against a disposable test card on the `io`
   board, to confirm the verify-after-write logic matches `grid.py`'s proven behaviour
   before anything touches this server exclusively.

## 9. Evaluation set (Phase 4)

Ten read-only questions per the mcp-builder methodology, but these need real board data
to write and verify — I can't fabricate plausible IAI card titles/ids from outside your
system. Once step 3 above happens, I'll draft the ten questions (e.g. "how many cards on
the `io` board are `status: gate` and owned by `alex`", "what does card `IO-0xx`
depend on") and verify each answer by hand against the live response before finalizing
the XML.

## 10. Migration path for the existing skills

Once built and verified, `grid-board-ops` and `fenn-handover` can be slimmed from
"here's a Python script, run it" to "call `iai_read_board` / `iai_update_card` / etc." —
same trap-handling, no shell-out. I'd do that as a separate follow-up edit to those two
skills once the MCP server is proven, not as part of this build, so nothing breaks
mid-flight for other agents actively using the current skills.

---

## 11. Rollback & safety plan

Nothing about this build requires touching what already works. Every stage has a plain
way back out.

**During build (lowest risk):**
- `grid.py` and the fenn-handover curl call are not modified or removed at any point in
  this build. They keep running exactly as they do today. The new server is purely
  additive until you decide otherwise.
- The new MCP server only becomes reachable to an agent once it's registered as a
  connector in a session's config. Not registering it (or removing the registration) is
  a full, instant rollback with zero blast radius — no data, no other tool, is touched
  by that switch.

**During testing (section 8):**
- Read tools (`iai_read_board`, `iai_get_card`, `iai_list_boards`) are exercised first
  and exclusively, against the live board, with zero write risk.
- The first writes happen against a single dedicated test card I'll create up front —
  clearly titled (e.g. `[MCP TEST — safe to ignore/delete]`) — never against a real
  sprint item. Create, patch, verify, then delete/supersede that card once the flow is
  proven.
- Every write tool already inherits `grid.py`'s re-query-and-confirm behaviour, so a
  write either verifiably lands or comes back `ok: false` — there's no silent
  corruption mode by design. What there isn't is an undo endpoint on the board API
  itself (no version history mentioned in any skill doc) — worth confirming with
  Dev/Alex whether one exists. Until confirmed, treat every write as a manual-correction
  situation if it goes wrong, same as a mistyped `grid.py` call would today.

**On the auth change specifically:**
- The riskiest single change is if the board API's *backend* is switched from
  "no auth required" to "Google auth required" as part of this work — that would break
  `grid.py` and any other current no-auth caller the moment it flips, independent of
  whether my OAuth flow is solid yet. Recommend sequencing this as: (1) build and prove
  the MCP server's OAuth flow against the board API while it still accepts unauthenticated
  calls, (2) only ask Dev/Alex to enforce auth server-side after that's verified working
  end to end. Don't flip enforcement and ship the new client in the same step.
- If the OAuth flow itself misbehaves (token exchange fails, refresh breaks, wrong
  scopes), the fallback is simply: board API keeps accepting no-auth calls (per today's
  state) so `grid.py` keeps working regardless of what the new server is doing.

**Once skills are migrated (section 10, later and separate):**
- That migration only happens once the server is proven, and it happens as a normal
  version-controlled edit to `grid-board-ops`/`fenn-handover` — so a git revert of that
  specific change restores the shell-script/curl behaviour immediately if anything about
  the new tools misbehaves in real sessions. I wouldn't do this migration in the same
  session as the initial build.

In short: additive build → read-only proof → single disposable test card → only then
consider retiring the old path, each step independently reversible with nothing shared
between "new server exists" and "old scripts still work."

---

## 12. Discovery: `marnie-iai/base` is the real backend behind two of these three APIs

While working out where to file this project in GitHub, I inspected
`marnie-iai/base` (the repo Marnie chose to host it in) and its README
turned out to answer several open questions directly:

- **`base.integratedai.com.au` is a thin Node/Express proxy**, not a
  database of its own. It fronts five live sources: the private
  `marnie-iai/kb` repo, `marnie-iai/agent-portraits`, the Grid API
  (`api.integratedai.com.au`), the Anthropic API, and a Turso (libsql)
  database for exactly one table: `agent_context`.
- **DEV-010 is real, deployed code**, not a stub: `GET /api/agent-context/:agent_id`
  and `POST /api/agent-context`, bearer-authed with `AGENT_API_KEY`, sitting
  *before* site auth specifically so agents can call it without the Basic
  password. This server's `contextClient.ts` already uses that exact env
  var name — no change needed.
- Per Base's own README, those endpoints return `503` if `TURSO_URL` /
  `TURSO_AUTH_TOKEN` / `AGENT_API_KEY` aren't set in Railway — which lines up
  exactly with the graceful-degradation behaviour already built into
  `iai_get_agent_context` / `iai_post_agent_context`. Worth a quick check
  with Dev/Alex on whether those three are actually set; if they are, the
  "experimental" tools may simply work today.
- **The Grid API itself (`api.integratedai.com.au`, the sprint board) is
  confirmed to be a separate service** — Base only proxies read requests to
  it ("Grid API | Pursuits registry, live sprint board | none [auth]"),
  consistent with `grid.py` sending no auth header. Its actual backend code
  is not in this repo, so the OAuth-enforcement sequencing question in
  section 11 still applies to whatever repo does hold it.
- Base's README also names the three-system boundary IAI uses: **Base**
  (the platform/window layer, stores almost nothing itself), **KB**
  (`marnie-iai/kb`, what IAI knows and produces), and **Vault** (external
  intelligence). `iai-ops-mcp` doesn't fit neatly into any of the three — it's
  a client/tool layer that talks to Base and Grid rather than a store of its
  own — so it's filed at `mcp/iai-ops-mcp/` in the `base` repo rather than at
  the repo root, to avoid colliding with Base's existing `package.json`,
  `server.js`, and `docs/guides/` (which document Base's own human-facing
  surfaces, not this server).
