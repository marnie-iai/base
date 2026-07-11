# iai-ops-mcp

MCP server wrapping three IAI-internal APIs so any agent (Reid, Morgan, Harlow, Lumen,
Sterling, Mirror, Arna, Cowork sessions, Claude Code) gets typed, verified tool calls
instead of shell-script or hand-rolled curl:

1. **Sprint board** (`api.integratedai.com.au`) — read/create/update/verify cards across
   the main board and every pursuit board (`io`, `eng`, `iv`, `pc`, `hif`, `hed`, `hma`,
   `ws`).
2. **Fenn debrief** (`iops.integratedai.com.au`) — post a session-close debrief as a
   pending record.
3. **Agent context store** (`base.integratedai.com.au`, DEV-010) — experimental, may not
   be live yet; tools degrade gracefully if so.

## Documentation

| Doc | For |
|---|---|
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | Setup, first-time sign-in, and common workflows |
| [`docs/TOOLS_REFERENCE.md`](docs/TOOLS_REFERENCE.md) | Every tool's inputs, outputs, and errors |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Project layout, request flow, how to extend it |
| [`../IAI_MCP_Server_Plan.md`](../IAI_MCP_Server_Plan.md) | Original design brief, open questions, rollback plan |

This README covers the fast path only — start with the User Guide for anything beyond
`npm install && npm run build`.

## Setup

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` (or set these in your MCP client's env config):

| Var | Required for | Notes |
|---|---|---|
| `IAI_BOARD_OAUTH_CLIENT_ID` / `IAI_BOARD_OAUTH_CLIENT_SECRET` | any `iai_*` board tool | Google OAuth Desktop-app client for `api.integratedai.com.au`. Confirm with Dev/Alex whether an existing client (they mentioned ones for iOps/Engage) already covers this before registering a new one. |
| `IAI_DEFAULT_AGENT` | board writes | Defaults to `alex` if unset. |
| `IOPS_DEBRIEF_TOKEN` | `iai_send_fenn_debrief` | |
| `AGENT_API_KEY` | `iai_get_agent_context` / `iai_post_agent_context` | Optional — those two tools soft-fail if unset. |

## First run: board sign-in

The first call to any board tool (or an explicit call to `iai_board_login`) opens a
browser for Google sign-in as `marnie@integratedcoatingservices.com`. The refresh token
is cached at `~/.config/iai-ops-mcp/board-token.json` (mode 600) so this is a one-time
login per machine, not per session.

**Do not** flip the board API itself to require this auth until the flow has been
proven end-to-end against the live, currently-unauthenticated API — see the rollback
section of the plan doc. Until `IAI_BOARD_OAUTH_CLIENT_ID` is set, board tools return a
clear configuration error rather than crashing the server.

## Registering with an MCP client (stdio)

Example config entry (Claude Desktop / Claude Code style):

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

## Testing

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Exercise read tools first (`iai_list_boards`, `iai_read_board`, `iai_get_card`) — zero
write risk. Test writes only against a disposable, clearly-labelled test card, never a
real sprint item. See the plan's rollback section for the full sequencing.

## Tools

**Board:** `iai_list_boards`, `iai_read_board`, `iai_get_card`, `iai_create_card`,
`iai_update_card`, `iai_verify_card`, `iai_list_ageing_backlog`, `iai_board_login`

**Debrief:** `iai_send_fenn_debrief`

**Agent context (experimental):** `iai_get_agent_context`, `iai_post_agent_context`
