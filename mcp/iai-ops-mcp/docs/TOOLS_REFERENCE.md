# Tools Reference

Full reference for all 11 tools. Each entry lists purpose, inputs, output
shape, annotations, and known errors. Everything here also ships inside the
tool's own `description` field, so an agent calling this server sees it
without reading this file — this document is for humans reviewing or
extending the server.

Annotation legend: **RO** = readOnlyHint, **D** = destructiveHint,
**I** = idempotentHint, **OW** = openWorldHint.

---

## Board domain

### `iai_list_boards`

Static reference of known pursuit board codes and their endpoints.

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:** none
- **Output:** `{ boards: [{ code, endpoint }, ...] }`
- **Errors:** none — this never calls the network.

### `iai_read_board`

Fetches cards from one board, filtered client-side.

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:**

  | Field | Type | Required | Notes |
  |---|---|---|---|
  | `board` | string | yes | e.g. `io`, `eng`, `iv`, `pc`, `main`, `hif`, `hed`, `hma`, `ws` |
  | `status` | string | no | exact match, applied client-side |
  | `owner` | string | no | case-insensitive exact match, applied client-side |
  | `include_closed` | boolean | no, default `false` | includes complete/backlog/dormant/superseded/dumpster |
  | `response_format` | `"markdown"` \| `"json"` | no, default `"markdown"` | |

- **Output (markdown):** a table of `cardId | status | priority | owner | title`.
- **Output (json):** `{ board, count, cards: Card[] }`, truncated at 25,000
  characters with a note if exceeded.
- **Errors:** unrecognised board code (with the known-codes list); network
  errors; 401 if not signed in.
- **Example:**
  ```
  iai_read_board({ board: "io", status: "gate" })
  → "# Board: io (2 cards)\n\n| cardId | status | priority | owner | title |\n..."
  ```

### `iai_get_card`

Fetches one card by cardId or numeric id.

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:** `board` (string, required), `ref` (string, required — `"IO-038"` or `"38"`)
- **Output:** `{ card: Card }`, or a plain "no card found" message.
- **Errors:** unrecognised board code; network/auth errors.

### `iai_create_card`

Creates a new card (POST).

- **Annotations:** RO✗ D✓ I✗ OW✓
- **Inputs:**

  | Field | Type | Required |
  |---|---|---|
  | `board` | string | yes |
  | `title` | string | yes |
  | `description` | string | yes |
  | `owner` | string | yes |
  | `domain` | string | yes |
  | `status` | string | yes |
  | `priority` | `"must"` \| `"should"` \| `"could"` | no |
  | `dependsOn` | array of cardId/numeric id | no — resolved to integers |
  | `briefRef`, `referenceUrl`, `filedPath`, `outputPath`, `marnieAction`, `sessionNotes` | string | no |
  | `agent` | string | no, defaults to `IAI_DEFAULT_AGENT` (`alex`) |

- **Output:** `{ card }` — the created card, including its assigned `cardId`
  and numeric `id`. Text response states both plainly: `"Created IO-041 (id
  41) on board 'io'."`
- **Errors:** unrecognised board code; a `dependsOn` entry that can't be
  resolved to a numeric id; network/auth errors.

### `iai_update_card`

Patches a card and verifies the write.

- **Annotations:** RO✗ D✓ I✗ OW✓
- **Inputs:** `board`, `ref` (required); at least one of `status`, `owner`,
  `priority`, `sessionNotes`, `briefRef`, `referenceUrl`, `marnieAction`,
  `dependsOn` (required — an "at least one field" error is returned if none
  are given); `agent` (optional).
- **Output:** `{ ok: boolean, card: unknown }`. Text response is
  `"Updated ... — verified."` or a `WARNING:` if the re-query didn't confirm
  the change.
- **Verification behaviour:** waits 600ms, re-fetches the card, and compares
  the first changed field provided (`status` takes priority if present)
  against what was sent. `ok: false` means retry — it does not mean the
  request failed outright, it means the change wasn't confirmed to have
  landed.
- **Errors:** unrecognised board code; unresolvable `ref` or `dependsOn`
  entry; network/auth errors.

### `iai_verify_card`

Re-queries a card and checks field values.

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:** `board`, `ref` (required), `expected` (object of field/value
  pairs, required)
- **Output:** `{ ok: boolean }` — `true` only if every field in `expected`
  string-matches the live card.
- **Errors:** unresolvable `ref`; network/auth errors.

### `iai_list_ageing_backlog`

Fetches the Monday ageing/backlog view.

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:** `board` (string, optional — omit for the main board)
- **Output:** `{ data: unknown }` — raw passthrough, since the response
  shape has not been confirmed against the live API (see the plan doc's
  open question #4). Treat as provisional.
- **Errors:** network/auth errors; the endpoint itself may not exist as
  described — a 404 here should be reported back, not assumed to mean "no
  ageing cards."

### `iai_board_login`

Runs the interactive Google sign-in flow.

- **Annotations:** RO✗ D✗ I✗ OW✓
- **Inputs:** `force` (boolean, optional, default `false`) — re-authenticate
  even if a cached session exists.
- **Output:** `{ email?: string }` — the signed-in account, if it could be
  determined.
- **Behaviour:** opens a system browser to Google's consent screen via a
  local loopback redirect; caches the resulting refresh token to
  `~/.config/iai-ops-mcp/board-token.json` (mode 600).
- **Errors:** `IAI_BOARD_OAUTH_CLIENT_ID` not set; OAuth error returned by
  Google (e.g. consent denied).

---

## Debrief domain

### `iai_send_fenn_debrief`

Posts a session-close debrief to Fenn as a pending record.

- **Annotations:** RO✗ D✓ I✗ OW✓
- **Inputs:**

  | Field | Type | Required | Notes |
  |---|---|---|---|
  | `job` | string | yes | as named on the iOps Jobs board |
  | `date` | string (`YYYY-MM-DD`) | no, defaults to today | AEST |
  | `hours` | number, 0–24 | yes | decimal hours |
  | `summary_internal` | string | yes | full detail, internal only |
  | `summary_client` | string | no | omit entirely if nothing is client-visible |
  | `actions` | array of `{ fn, ...args }` | no | `fn` restricted to 6 enum values |

- **Output:** `{ id, status }` on success (HTTP 201).
- **Errors:** `IOPS_DEBRIEF_TOKEN` unset; 401 (wrong token); 503 (token not
  configured server-side); 409 `fenn_debriefs_migration_pending` (migration
  0049 not run — payload is not lost, just needs resending later).
- **Confirm-first:** this tool creates a record the instant it's called —
  the calling agent is responsible for showing the human the full payload
  and getting explicit approval first. The tool description states this;
  nothing in the code itself can enforce it.

---

## Agent context domain (experimental — DEV-010)

Both tools here were built against a store reported **not yet live**. They
never throw — every failure mode (unset key, unreachable, non-2xx) resolves
to a soft `available: false` / `ok: false` result with an explanatory note.

### `iai_get_agent_context`

- **Annotations:** RO✓ D✗ I✓ OW✓
- **Inputs:** `agent_id` (string, required — lowercase slug e.g. `reid`),
  `limit` (number, 1–20, default 3)
- **Output:** `{ available: boolean, records: unknown[], note?: string }`

### `iai_post_agent_context`

- **Annotations:** RO✗ D✓ I✗ OW✓
- **Inputs:** `agent`, `session_date` (`YYYY-MM-DD`) required;
  `work_completed`, `decisions_made`, `open_items`, `flags` (arrays,
  default `[]`); `week`, `carry_forward` (optional strings)
- **Output:** `{ ok: boolean, note?: string }`
