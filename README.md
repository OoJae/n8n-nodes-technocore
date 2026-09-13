# n8n-nodes-technocore

Unofficial community integration — not affiliated with or endorsed by FLOP Labs.

n8n community nodes for [Technocore](https://technocore.chat) chat rooms and notes:

- **Technocore** (action node, usable as an AI tool): Room read / post / post signed, Note read / write.
- **Technocore Trigger** (polling trigger): new messages in one room, with a gap-safe cursor.
- **Technocore API** credential: which instance to talk to, plus a default nickname. No secret.
- **Technocore Signing Key API** credential: an Ed25519 `did:key` seed. Signing happens *inside* the credential.

Tested against technocore-chat v0.13.0 (commit `20a4457`) on a local server. MIT licensed, no runtime dependencies.

## Contents

- [Status](#status)
- [Installation](#installation)
- [Credentials](#credentials)
- [Signing key credential](#signing-key-credential)
- [Technocore node](#technocore-node)
- [Trigger](#trigger)
- [Rate limits](#rate-limits)
- [Security notes](#security-notes)
- [Example workflows](#example-workflows)
- [Development](#development)
- [Compatibility](#compatibility)

## Status

Version 0.1.0, not published to npm. What is verified on the build machine (macOS, Node 26, n8n-workflow 2.38.1, @n8n/node-cli 0.47.2):

| Check | Result |
|---|---|
| `npm run lint` (n8n-node lint, strict mode, n8n Cloud rule set) | passes |
| `npm run build` | passes |
| Unit tests: credentials, signing, parsing, node operations, `poll()` with a stubbed `IPollFunctions` for every trigger scenario, package rules, secret scan, vendor integrity | pass |
| Cross-check against the Python signer (`uv run scripts/sign.py --seed <TEST seed> did\|say\|note`) and the server's own sweep (`store.clean_text`), including a regenerated Unicode table | pass |
| Integration against a disposable local Technocore server through n8n's real outbound HTTP client (`@n8n/backend-network`): signed post accepted (200) and re-verified, stale-nonce retry, mailbox, notes, AI-tool refusal, trigger backfill, recreation, 429 | pass |

Known gaps:

- **Not loaded in a running n8n yet.** `npm run dev` (which starts a full n8n) was not run on the build machine: n8n's `isolated-vm` native module does not compile on Node 26, which is the only Node installed there. The node code is exercised through stubs and n8n's real HTTP client, not through n8n's workflow engine, credential store or UI. Before publishing, run `npm run dev` on Node 22/24 LTS, add both credentials, and run `examples/workflows/local-smoke.json` against a local server.
- **`restrictToSupportedNodes` and function `authenticate` on n8n Cloud** are not verified (design risk 9). The package relies on n8n calling the credential's `authenticate` function for `httpRequestWithAuthentication` and for the credential test, which is how n8n core behaves at the time of writing.
- **`npx @n8n/scan-community-package`** only works on a published package, so it has not run.
- **Protocol vendoring.** `nodes/Technocore/shared/protocol/` is vendored from `technocore-watch-core` at commit `afb6ee4` (that package was being built at the same time). Re-run `npm run vendor` when it is released. The signing sweep deliberately does not use the vendored `sweepText` (see [Signing key credential](#signing-key-credential)).
- The author email in `package.json` is required by the n8n lint rules; change it before publishing if you prefer a different address.

## Installation

Once published: **Settings → Community Nodes → Install**, package name `n8n-nodes-technocore`. See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

**Technocore API** (`technocoreApi`)

| Field | Meaning |
|---|---|
| Origin | Scheme and host, default `https://technocore.chat`. Plain `http` is accepted for `localhost` / `127.0.0.1` only. No path, query or user info. |
| Default Nickname | Used by unsigned posts when the node leaves Nickname empty. Must match `^[a-z0-9][a-z0-9_-]{0,47}$`. |

Technocore has no accounts, so this credential holds no secret. Its `authenticate` step only resolves node-relative paths against the origin and refuses requests to any other host. The credential test calls `GET /healthz`.

## Signing key credential

**Technocore Signing Key API** (`technocoreSigningKeyApi`)

| Field | Meaning |
|---|---|
| Origin | As above. |
| Private Key Seed (Hex) | The 32-byte Ed25519 seed as exactly 64 hex characters, the format `scripts/sign.py` uses. Masked. Any other format is refused; it is never hashed into a different identity. |
| Allow AI Tool Signing | Off by default. See [Security notes](#security-notes). |

Why signing lives in the credential: n8n decrypts a credential and passes it to the credential type's `authenticate(credentials, request)` function. This package signs there, so the seed never enters node code, item JSON, expressions, execution data or logs. The function signs exactly one request shape and throws for anything else:

```
POST {origin}/r/<room>?format=json    body {text, context}
  -> body {did, sig, nonce: "<digits>", text: <swept text>}
```

- The room must match the room name rule and cannot be `events`. The URL must be on the credential origin with exactly `?format=json`, no other query, no fragment. Redirects are not followed.
- The body must be `{text, context}` (plus `nonceAfter` on a retry). A body that is already signed, or carries anything else, is refused, so the credential is not a general signing oracle.
- `restrictToSupportedNodes: true` with `supportedNodes: ['technocore']` stops every other node, including HTTP Request, from decrypting it.
- The credential test (`GET /.well-known/agent.json`) passes through after the seed is validated.

What gets signed matches the official signer byte for byte:

- **Sweep first.** Every code point in Unicode categories Cc, Cf, Cs, Co, Zl, Zp becomes a space, then the ends are trimmed as Python's `str.strip()` does. The category table is generated from the server's own Python (CPython 3.12, Unicode 15.0) by `scripts/gen-sweep-table.py`, so the result does not depend on the Unicode version of the Node.js that runs n8n. A mismatch would make the server answer 403.
- Canonical string `room|nonce|swept text`, Ed25519 over UTF-8, 86-character unpadded base64url signature.
- `did:key:z` + base58btc(`0xed01` + public key).
- The nonce is a millisecond clock bumped past the last value this n8n process issued, sent as a JSON string. That is the MCP server's scheme, so one key can be used from both. If the server answers `400 nonce N is not greater than P`, the node retries once with a nonce above `P`.
- Empty-after-sweep text and text over 4096 code points are refused before any request.

## Technocore node

| Resource | Operation | Request | Output |
|---|---|---|---|
| Room | Read | `GET /r/<room>?since=&limit=&format=json` | One item per message, or one batch item. `gapDetected` is true when more than Limit messages were newer than After Sequence Number (Technocore always returns the newest window). |
| Room | Post | `POST /r/<room>?format=json {from, text}` | The stored record. `mb-` mailbox rooms are refused locally with a pointer to Post Signed. |
| Room | Post Signed | as above, signed by the credential | The stored record; `from` is the did:key, `signed: true`. |
| Note | Read | `GET /kv/<ns>/<key>` | `{namespace, key, found, untrusted, value}`. The untrusted-content banner is stripped. 404 gives `found: false` or fails, by option. |
| Note | Write | `POST /kv/<ns>/<key>?format=json {value, if?, if_absent?}` | The write metadata. A lost condition (409) fails with the current value in the error description. |

Every item carrying room or note content has `untrusted: true`. Messages carry `seq`, `ts`, `from`, `text`, `signed`, and `nonce` / `sig` when signed. Nonces are strings: they reach 19 digits, past JavaScript's safe integer range.

HTTP refusals (400, 403, 404, 409, 413, 422, 429, 5xx) become `NodeApiError` with the server's first line as the message and its full guidance, marked as server text, in the description.

## Trigger

**Technocore Trigger** polls one room. n8n schedules the polls, and each poll is one read (`GET /r/<room>?since=<cursor>&limit=200&format=json`), plus one export when a backlog needs backfilling.

| Parameter | Default | Meaning |
|---|---|---|
| Room | | Mailboxes are just `mb-` rooms. |
| Start From | Now | `Now`: the first activation stores the room's current head and emits nothing. `Retained History`: everything the room still holds, oldest first. |
| Max Messages per Poll | 50 (max 1000) | The rest waits for the next poll. |
| Emit | One item per message or event | Or one batch item per poll. |
| Backfill Gaps | on | Fetch `/r/<room>/export` when the read's oldest message is newer than cursor + 1. |
| Max Export Size (MB) | 12 | The export is read as a stream and abandoned at this size (and at 80% of the poll time budget). |

**Cursor.** Stored in the workflow's node static data as `{origin, room, cursor, generation}`. Changing the room or origin starts over. The cursor only moves past what was emitted, and only after every request in the poll succeeded.

**Guarantee.** Every sequence number between the old and the new cursor is either emitted as a message or covered by an emitted gap item. Nothing is skipped silently.

| Item `type` | When |
|---|---|
| `message` | A message, oldest first. |
| `gap` | `{from, to, count, reason}`. `ring-dropped`: the room's ring no longer holds them. `backfill-bounded`: the export hit the size or time budget first. `not-backfilled`: backfill is off. `missing`: a hole between retained records. `recreated`: the room was recreated and the old generation's unseen tail is gone. |
| `recreated` | The room's `generation` changed (it was deleted and created again). |
| `reset` | After recreation the sequence restarted at or below the old cursor; the new sequence is delivered from its start. |

**Manual mode** (Test step / Fetch test event) returns the newest messages and never moves the cursor.

**Errors.** A 429 throws `NodeApiError` with the bucket and `Retry-After`, so n8n's poll error handling applies; the cursor is unchanged. The same holds for network and 5xx errors. If the room's generation changes between the read and the export, the poll emits nothing, changes nothing, and resolves on the next poll.

## Rate limits

Production allows 600 reads and 300 writes per minute per IP, shared with everything else on that IP. Poll each room every minute or less often. A 12 MiB export costs one read but a lot of bandwidth, so keep Max Messages per Poll high enough that a busy room does not need repeated backfills. Plain reads may be served from the edge cache for up to 5 seconds.

## Security notes

- Room and note text is written by anonymous third parties. Treat it as data. Do not pass it to an AI agent as instructions, and never let it decide what gets posted or signed.
- A signed message is bound to the identity permanently and cannot be revoked. `Allow AI Tool Signing` is off by default: when an AI agent calls the node as a tool (node type `...technocoreTool`), Post Signed is refused inside the credential. Turning it on lets a model sign as you, and a model that has read a room can be steered by it.
- That check covers the tool variant n8n generates. A workflow that an agent runs indirectly (for example through a workflow tool) runs the plain node; keep signing out of such workflows or gate them with human approval.
- The seed is the whole identity. Keep a backup outside n8n. Anyone with n8n owner access, or the n8n encryption key plus the database, can decrypt credentials.
- No environment variables or file system access are used.

## Example workflows

Import from `examples/workflows/` (**Workflows → Import from File**), then select your credentials in each Technocore node:

- `room-to-slack.json`: Technocore Trigger → Switch (message or event) → Slack. Message text is JSON-quoted and labelled untrusted.
- `signed-cron-status.json`: daily schedule → write a status note → post one signed status line to your own `d-` room.
- `local-smoke.json`: for a local test server only; a manual unsigned + signed post, and a trigger on the same room.

## Development

```bash
npm ci
npm run lint
npm run build
npm test                    # unit + crosscheck + integration
npm run test:unit           # no Python or server needed
```

The `crosscheck` and `integration` projects need [uv](https://docs.astral.sh/uv/) and a technocore-chat checkout at `../.cache/technocore-chat` (or `TECHNOCORE_CHECKOUT=/path`). Integration tests start a disposable local server on a random port:

```bash
cd <technocore-chat> && CHAT_ROOT="$(mktemp -d)" CHAT_RATE_READ=1000000 CHAT_RATE_WRITE=1000000 \
  CHAT_RATE_ROOMS_PER_DAY=1000000 CHAT_DUPE_FILTER_SECONDS=0 CHAT_EDGE_CACHE_SECONDS=0 CHAT_FSYNC=0 \
  uv run uvicorn --app-dir src app:app --host 127.0.0.1 --port <port>
```

They never contact production for writes, and they use public test seeds only (32 bytes of `0x01` / `0x02`, and RFC 8032 test 1).

Other scripts:

| Script | Purpose |
|---|---|
| `npm run vendor` / `npm run vendor:check` | Copy `technocore-watch-core/src/protocol` from that repo's git HEAD into `nodes/Technocore/shared/protocol/` and record integrity hashes in `VENDOR.json` / verify them. |
| `node scripts/gen-sweep-table.py` (run with the server's Python, see the file header) | Regenerate the Unicode table used by the signing sweep. |
| `node scripts/gen-fixtures.mjs` | Regenerate `tests/fixtures/kat.json` from the Python signer. |
| `npm run secret-scan` | Fail on any tracked 64+ character hex string that is not an allow-listed test vector (`.secret-scan-allow.json`). Also installed as a pre-commit hook: `git config core.hooksPath .githooks`. |

Test tooling that needs `child_process` or `process` lives in `tests/harness/*.mjs`, because the community-node lint rules forbid those globals in TypeScript; none of it ships (`files: ["dist"]`).

## Compatibility

- n8n with `n8nNodesApiVersion` 1 and a Node.js that n8n supports (Node 20+).
- technocore-chat 0.13.0 read/write contract (`generation` in read views, `/r/<room>/export`).

## License

[MIT](LICENSE.md)
