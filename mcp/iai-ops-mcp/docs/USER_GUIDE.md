# User Guide

For Marnie, or anyone setting this server up for an agent to use. For what
each individual tool accepts and returns, see `TOOLS_REFERENCE.md`. For how
the code is structured, see `ARCHITECTURE.md`.

## 1. What this gets you

Right now, reading or writing the IAI sprint board means an agent runs
`grid.py` (a Python script) or hand-rolls curl. Every agent has to know the
same set of traps: abbreviated board codes, numeric-id-vs-cardId, the
`sessionNotes` timestamp doubling, writes that silently revert. This server
turns all of that into typed tool calls any MCP-capable agent can use
directly, with the trap-handling built in rather than re-learned each time.

`grid.py` and the existing debrief curl call keep working exactly as they do
today — this is additive, not a replacement, until you decide otherwise (see
the rollback section of `../../IAI_MCP_Server_Plan.md`).

## 2. One-time setup

```bash
cd iai-ops-mcp
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in what you have:

```bash
cp .env.example .env
```

| Variable | Needed for | Where it comes from |
|---|---|---|
| `IAI_BOARD_OAUTH_CLIENT_ID` / `SECRET` | any board tool | Google Cloud Console — confirm with Dev/Alex whether an existing Desktop-app client already covers `api.integratedai.com.au` before creating a new one |
| `IOPS_DEBRIEF_TOKEN` | `iai_send_fenn_debrief` | wherever the existing fenn-handover skill's token is stored today |
| `AGENT_API_KEY` | the two experimental context tools | only if you want those active — safe to leave unset |
| `IAI_DEFAULT_AGENT` | board writes | optional, defaults to `alex` |

## 3. Registering with your MCP client

However you run agents (Claude Desktop, Claude Code, Cowork), point it at
the built server as a **stdio** MCP server:

```json
{
  "mcpServers": {
    "iai-ops": {
      "command": "node",
      "args": ["/absolute/path/to/iai-ops-mcp/dist/index.js"],
      "env": {
        "IAI_BOARD_OAUTH_CLIENT_ID": "...",
        "IAI_BOARD_OAUTH_CLIENT_SECRET": "...",
        "IOPS_DEBRIEF_TOKEN": "...",
        "AGENT_API_KEY": "..."
      }
    }
  }
}
```

Restart the client after editing its config. You should see 11 `iai_*` tools
available.

## 4. First-time board sign-in

The first time any agent calls a board tool (or you explicitly call
`iai_board_login`), a browser window opens for Google sign-in. Sign in as
**marnie@integratedcoatingservices.com**. After that, a refresh token is
cached at `~/.config/iai-ops-mcp/board-token.json` — future sessions reuse
it silently, no repeat login.

If a board tool ever comes back with a 401 or "not signed in" error, ask the
agent to call `iai_board_login` (or run it yourself) to refresh the session.

## 5. Common workflows

### "What's on the io board right now?"

> Call `iai_read_board` with `board: "io"`.

Returns a markdown table of every non-closed card: cardId, status, priority,
owner, title. Add `status: "gate"` to see only gated cards, or `owner:
"alex"` to see only Alex's.

### "Show me everything about IO-038"

> Call `iai_get_card` with `board: "io"`, `ref: "IO-038"`.

Returns the full card object.

### "Raise a new card for this piece of work"

> Call `iai_create_card` with `board`, `title`, `description`, `owner`,
> `domain`, `status`, and optionally `priority`, `dependsOn`, `briefRef`.

The response includes both the display `cardId` (e.g. `IO-041`) and the
numeric `id` — keep both, since any later `iai_update_card` call on this
card needs the numeric id (though it also accepts the cardId and resolves it
for you).

### "Mark IO-038 as in review with a note"

> Call `iai_update_card` with `board: "io"`, `ref: "IO-038"`,
> `status: "review"`, `sessionNotes: "retest passed, IAI-0368"`.

**Do not** put a date at the start of `sessionNotes` — the API adds its own
timestamp automatically, and a manual one doubles up. The tool re-checks the
board after writing and tells you plainly if the change didn't verify (in
which case, just re-run it).

### "Did that write from a minute ago actually stick?"

> Call `iai_verify_card` with `board`, `ref`, and
> `expected: { "status": "review" }`.

Returns `true`/`false`.

### "Send today's session to Fenn"

> Only after you've reviewed the payload — job, hours, both summaries, any
> actions — call `iai_send_fenn_debrief`.

This creates a **pending** record only. Nothing is logged or published in
iOps or the Engage portal until you separately confirm it there. Remember
the internal/client summary split: if nothing about the session is
client-visible, leave `summary_client` out entirely rather than writing a
softened version of the internal one.

## 6. When something goes wrong

| Symptom | What's happening | What to do |
|---|---|---|
| "Not signed in to the board API" | No cached token, or `IAI_BOARD_OAUTH_CLIENT_ID` unset | Set the env var, or run `iai_board_login` |
| "401 ... Google session may have expired" | Cached token stopped working | Run `iai_board_login` |
| "Unrecognised board code" | Typo, or a genuinely new pursuit not yet in the known list | Check the exact code from the board's own URL — the tool will still attempt it |
| "WARNING: write did not verify" | The board API didn't reflect the change on re-query | Re-run the same update once; if it keeps failing, check the board directly before assuming anything landed |
| "IOPS_DEBRIEF_TOKEN is not set" | Env var missing | Set it in your MCP client's config |
| "409 fenn_debriefs_migration_pending" | Migration 0049 hasn't run on the iOps side yet | Nothing was lost — hold the payload and resend once it has |
| Agent context tools say "not available" | Expected — DEV-010 wasn't live as of this build | No action needed; these tools are experimental by design |

## 7. What this does *not* do (yet)

- It doesn't touch the KB repo (commits still go through the existing
  Clio-KB-MCP / GitHub-style connector) or the Drive Inbox.
- It doesn't replace `grid-board-ops` or `fenn-handover` — that migration is
  a deliberate, separate follow-up once this server is proven live (see the
  plan doc's rollback section).
- The `/sprint/ageing` tool (`iai_list_ageing_backlog`) is built defensively
  against an endpoint whose response shape has never been confirmed —
  treat its output as provisional until validated on a real call.
