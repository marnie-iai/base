# Architecture

How `iai-ops-mcp` is put together, and why. For what each tool does, see
`TOOLS_REFERENCE.md`. For how to actually use it day to day, see
`USER_GUIDE.md`. For the design decisions and open questions this was built
against, see `../../IAI_MCP_Server_Plan.md`.

## Project layout

```
iai-ops-mcp/
├── package.json, tsconfig.json      — standard Node/TS project config
├── README.md                        — quick start, links to the rest
├── docs/
│   ├── ARCHITECTURE.md              — this file
│   ├── USER_GUIDE.md                — setup + common workflows
│   └── TOOLS_REFERENCE.md           — every tool: inputs, outputs, errors
└── src/
    ├── index.ts                     — server entrypoint (stdio transport)
    ├── constants.ts                 — API base URLs, board codes, limits
    ├── types.ts                     — Card / DebriefAction interfaces
    ├── format.ts                    — markdown table + truncation helpers
    ├── services/                    — one HTTP client per external API
    │   ├── boardAuth.ts             — Google OAuth for the board API
    │   ├── boardClient.ts           — sprint board CRUD + trap handling
    │   ├── debriefClient.ts         — Fenn iOps debrief POST
    │   └── contextClient.ts         — DEV-010 agent context (experimental)
    ├── schemas/                     — one Zod file per domain
    │   ├── board.ts
    │   ├── debrief.ts
    │   └── context.ts
    └── tools/                       — one MCP tool-registration file per domain
        ├── board.ts                 — 8 tools
        ├── debrief.ts                — 1 tool
        └── context.ts                — 2 tools
```

**The rule that keeps this maintainable:** each layer has exactly one job.

- **`schemas/*.ts`** — what a valid call looks like. Pure Zod, no HTTP, no
  business logic. If a field's meaning isn't obvious from its name, it gets a
  `.describe()`, because that text is what an MCP client actually sees.
- **`services/*.ts`** — how to actually talk to the external API. All the
  trap-handling, retries, and verify-after-write logic lives here. Nothing
  in this layer knows it's being called from an MCP tool — these are plain
  async functions you could unit test or call from a script.
- **`tools/*.ts`** — the MCP-facing glue. Registers each tool with
  `server.registerTool`, wires the Zod schema in, calls the matching
  `services/` function, and turns the result (or a thrown error) into the
  `{ content, structuredContent }` / `{ isError, content }` shape MCP
  expects. No business logic here — if you're writing an `if` statement
  that isn't about formatting the response, it belongs in `services/`.
- **`index.ts`** — wires the three domains together and starts the stdio
  transport. Nothing else.

## Request flow (a board write, as the worked example)

```
agent calls iai_update_card
        │
        ▼
tools/board.ts            — Zod validates params against UpdateCardInput
        │                    (unknown fields rejected — .strict())
        ▼
services/boardClient.ts   — resolveId(): cardId → numeric id if needed
        │                    patchCard(): builds the PATCH body
        ▼
services/boardAuth.ts     — getAccessToken(): cached token, or refresh
        │                    via google-auth-library, or throw a clear
        │                    "run iai_board_login" error
        ▼
axios PATCH to the board API
        │
        ▼
services/boardClient.ts   — re-GET the card (verify-after-write) after each
        │                    of up to 3 retry delays (1s, 1.5s, 2.5s — ~5s
        │                    total), comparing the field that was just
        │                    changed, and stopping as soon as it matches
        ▼
tools/board.ts            — ok:true → "Updated, verified."
                             ok:false → "WARNING: did not verify, re-run."
```

Every write tool (`iai_create_card`, `iai_update_card`) and the debrief tool
follows the same shape: validate → delegate to a service → format. Every
service function either returns cleanly or throws a typed error
(`BoardApiError`, `BoardAuthError`, `DebriefApiError`) with an
already-actionable message, which `tools/*.ts`'s `errorResult()` helper
turns straight into the MCP error result — no error message is invented at
the tools layer, only passed through.

## Why the trap-handling lives where it does

Every quirk called out in `grid-board-ops`'s `SKILL.md` and `grid.py`'s
comments has exactly one home in this codebase, chosen so it can't be
bypassed by calling a different tool:

| Trap | Where it's handled |
|---|---|
| Abbreviated / wrong pursuit code | `services/boardClient.ts`'s `endpoint()` — validates against `constants.ts`'s `PURSUITS` before any request goes out |
| PATCH needs numeric id, not cardId | `services/boardClient.ts`'s `resolveId()`, called by every write path — a tool can never PATCH a raw cardId |
| `dependsOn` must be integers | `services/boardClient.ts`'s `toIntIds()`, called inside `postCard()`/`patchCard()` — not something a tool author (or a Zod schema) needs to remember |
| `sessionNotes` auto-timestamps, don't double it | Documented in the Zod field `.describe()` (schemas/board.ts) *and* the tool description (tools/board.ts) — this one can't be enforced in code without knowing the API's exact timestamp format, so it's a documentation control, not a code control |
| Writes can silently fail, revert, or just be slow to settle | `services/boardClient.ts`'s `patchCard()` — every write re-queries and compares, retrying up to 3 times (1s/1.5s/2.5s) before giving up, rather than checking once against a guessed fixed delay |
| `cards` vs `tasks` response key | `services/boardClient.ts`'s `cardsFrom()`, the single place that parses a board response |

If you're extending this server and find yourself re-implementing any of
these, stop — call the existing `services/boardClient.ts` function instead
of hand-rolling a new axios call.

## Why Google OAuth is its own module

`services/boardAuth.ts` is deliberately isolated from `boardClient.ts` so
the auth mechanism can change (e.g. a future move to a service account, or a
different scope set) without touching a single line of the trap-handling
logic. `boardClient.ts`'s `request()` function only knows one thing about
auth: call `getAccessToken()` and attach it as a bearer token. Everything
about *how* that token is obtained — the loopback HTTP server, the browser
launch, the token cache file, the refresh-on-expiry — is contained in
`boardAuth.ts` and exposed through exactly two functions: `getAccessToken()`
and `login()`.

**Known limitation, flagged in Reid's review (card 657):** there is currently
only one cached OAuth session per machine, always `marnie@integratedcoatingservices.com`.
The `agent` field on writes (e.g. `"alex"`, `"reid"`) is a payload value only
— it is not tied to authentication in any way. Every write, regardless of
what `agent` string is sent, is authenticated as the same Google identity.
This is the same class of problem the Managed Agents report's Finding 3
raised: the board API has no way to actually distinguish which agent
performed a write via auth, only what that agent claims about itself in the
request body. Fixing this properly needs either per-agent credentials or an
impersonation/delegation scheme on the board API's own side — it isn't
something this client can solve alone by changing how it calls
`getAccessToken()`.

## Extending this server

**Adding a field to an existing tool:** add it to the relevant `schemas/*.ts`
object, thread it through the matching `services/*.ts` function's params,
done. The tool file usually doesn't need to change unless the field affects
response formatting.

**Adding a new tool to an existing domain:** add a new `server.registerTool`
call in the matching `tools/*.ts` file, backed by a new (or existing)
`services/*.ts` function. Follow the pattern already there: Zod schema with
`.strict()` and `.describe()`s, `readOnlyHint`/`destructiveHint`/
`idempotentHint`/`openWorldHint` annotations set honestly, and route thrown
errors through `errorResult()`.

**Adding a new domain (a fourth API):** add `services/xClient.ts`,
`schemas/x.ts`, `tools/x.ts` following the existing three, then call
`registerXTools(server)` from `index.ts`. Nothing else needs to change —
this is why the domains don't import from each other.
