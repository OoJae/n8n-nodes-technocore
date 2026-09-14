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
- [Releasing](#releasing)
- [Compatibility](#compatibility)

## Status

Version 0.1.0, not published to npm. Verified on the build machine (macOS, Apple M5, Node 26 for the build and tests, n8n 2.38.7 on Node 24.21.0 for the end-to-end run; n8n-workflow 2.38.1, @n8n/node-cli 0.47.2, technocore-chat v0.13.0 at `20a4457`):

| Check | Result |
|---|---|
| `npm run lint` (n8n-node lint, strict mode, n8n Cloud rule set) | passes |
| `npm run build` | passes |
| `npm run scan:local` (the two ESLint legs of `@n8n/scan-community-package`, on the committed sources and the `npm pack` tarball) | passes |
| Unit tests (`npm run test:unit`): credentials, signing (per-room nonce counters, refused far-ahead nonces), signature verification of received records, parsing, node operations (409 current value), `poll()` with a stubbed `IPollFunctions` for every trigger scenario (time-bounded export resumed, activation on expired/reaped rooms, same-generation sequence restart, quiet-poll check), a randomized `assemble()` invariant test over report / suppress / recreated modes and size / time budgets, package rules, secret scan (UTF-8, UTF-16, binary), vendor integrity | 144 pass |
| Cross-check (`npm run test:crosscheck`) against the Python signer (`uv run scripts/sign.py --seed <TEST seed> did\|say\|note`) and the server's own sweep (`store.clean_text`), including a regenerated Unicode table | 9 pass |
| Integration (`npm run test:integration`) against a disposable local server through n8n's real outbound HTTP client (`@n8n/backend-network`): signed post accepted (200) and re-verified, stale-nonce retry and refusal of a nanosecond-scale nonce, mailbox, notes (8192-character 409 value rebased with Only If Unchanged), both credential tests, AI-tool refusal, trigger backfill, export resumed after the poll time budget, quiet-poll check, activation on an expired `e-` room and on a reaped room, Start From = retained without backfill, recreation, same-generation sequence restart (fresh store on the same origin), 429 | 26 pass |
| End to end in a real n8n (`npm run test:e2e`): the packed package installed as a community package, credentials stored encrypted by n8n, workflows run by n8n's engine and poll scheduler, local server | 8 pass |

The end-to-end run checks, inside n8n 2.38.7:

- n8n loads the Technocore node, the Technocore Trigger and the generated AI tool variant (`technocoreTool`).
- Unsigned and signed posts run with credentials decrypted by n8n; the signing credential's `authenticate` signs inside n8n and the server accepts the post (200, signature verifies). The execution data contains the did, never the seed.
- `restrictToSupportedNodes` works: an HTTP Request node given the signing credential fails with `Credential type "technocoreSigningKeyApi" is restricted to specific nodes` and nothing is posted.
- `examples/workflows/local-smoke.json` imports and runs as shipped (credentials reselected), and its trigger picks up a later post.
- Trigger: activation stores the head and emits nothing; a 250-message backlog posted while n8n was down arrives after restart as one batch (`count=250 from=3 to=252`, one signed), so the export backfill ran; scheduled polls deliver later messages exactly once; the cursor persists in the workflow's static data across restarts.

Known gaps:

- **Trigger limits that cannot be closed from the read API** (details in [Trigger](#trigger)): a sequence that restarts under the same generation is detected only while the room's newest message is still below the old cursor on a quiet poll; on a room with nothing visible at activation, messages posted after activation that are dropped or expire before the first delivery look like pre-activation history; an export that runs out of poll time before reaching the cursor on 3 polls in a row is reported as `backfill-bounded`.

- **`npm run dev` cannot use the signing credential.** `n8n-node dev` links the package into n8n's *custom* folder. n8n resolves a credential's `supportedNodes` list only for community packages, so with `restrictToSupportedNodes` every node, including this one, is refused (`Credential type "technocoreSigningKeyApi" is restricted to specific nodes`). Checked in n8n 2.38.7 with the package in the custom folder: an unsigned Post succeeded, Post Signed was refused. (The API credential is not restricted, so reads and notes are unaffected.) To try signed posts locally, install the `npm pack` tarball as a community package (what `tests/harness/real-n8n-instance.mjs` does) instead of using `npm run dev`. `npm run dev` itself was not run on the build machine: it starts `npx n8n@latest` with the system Node.js, which is Node 26 there, and n8n's `isolated-vm` module does not build on Node 26.
- **AI Agent tool path.** n8n generates and registers the tool variant (checked), but no AI Agent run was made in n8n (it needs a model). The refusal of Post Signed from the tool variant is tested through the node type n8n uses (`n8n-nodes-technocore.technocoreTool`), in unit and local-server integration tests only.
- **n8n Cloud** is not verified: whether it honours function `authenticate` and `restrictToSupportedNodes` for community nodes (design risk 9). Self-hosted n8n 2.38.7 does.
- **Credential test button.** Both credential test requests are run through `authenticate` and succeed against the local server in the integration tests, but the n8n UI/REST credential-test flow was not clicked through.
- **`npx @n8n/scan-community-package`** only works on a published package, so only its lint legs have run (`npm run scan:local`).
- **Protocol vendoring.** `nodes/Technocore/shared/protocol/` holds `names.ts`, `sweep.ts` and `types.ts` vendored from `technocore-watch-core` at commit `f9c4ab6` (see `VENDOR.json`; `npm run vendor:check` confirms the core's current HEAD has not changed them). `parse.ts`, `reconcile.ts` and `render.ts` are not vendored, for the reasons recorded in `VENDOR.json`. Re-run `npm run vendor` when the core package is released. The signing sweep deliberately does not use the vendored `sweepText` (see [Signing key credential](#signing-key-credential)).
- **No author email, so n8n's `valid-author` lint rule fails.** `package.json` names the author as `OoJae` with the GitHub profile URL and deliberately carries no email address (the secret scan refuses any email address in the repository). n8n's `@n8n/community-nodes/valid-author` rule requires a non-empty `author.email`, and the same rule runs in `npm run lint`, in `n8n-node release` (so in the publish workflow), and in the n8n verification scanner (`npm run scan:local`, `npx @n8n/scan-community-package`). Those fail on that one rule until an address is added to `author`.

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
- The nonce is a millisecond clock bumped past the last nonce this n8n process issued for the same origin, key and room (the server checks nonces per key per room), sent as a JSON string. That is the MCP server's millisecond scheme, so one key can be used from both. If the server answers `400 nonce N is not greater than P`, the node retries once with a nonce above `P`, and later posts to that room stay above it; posts to other rooms, keys or origins are unaffected. A reported `P` more than a day ahead of the clock is refused instead (for example a nanosecond counter used by another client with the same key): following it would lock millisecond-clock clients such as the MCP server out of that room, and an origin could otherwise push nonces to the 19-digit limit.
- Empty-after-sweep text and text over 4096 code points are refused before any request.

## Technocore node

| Resource | Operation | Request | Output |
|---|---|---|---|
| Room | Read | `GET /r/<room>?since=&limit=&format=json` | One item per message, or one batch item. `gapDetected` is true when more than Limit messages were newer than After Sequence Number (Technocore always returns the newest window). |
| Room | Post | `POST /r/<room>?format=json {from, text}` | The stored record. `mb-` mailbox rooms are refused locally with a pointer to Post Signed. |
| Room | Post Signed | as above, signed by the credential | The stored record; `from` is the did:key, `signed: true` once its signature verifies. |
| Note | Read | `GET /kv/<ns>/<key>` | `{namespace, key, found, untrusted, value}`. The untrusted-content banner is stripped. 404 gives `found: false` or fails, by option. |
| Note | Write | `POST /kv/<ns>/<key>?format=json {value, if?, if_absent?}` | The write metadata. A lost condition (409) fails with the whole current value in the error description and in the error's `context.currentValue`. With **Continue On Fail** the output item is `{error, conflict: true, currentValue, untrusted: true}`, so a workflow can rebase and retry with Only If Unchanged. |

Every item carrying room or note content has `untrusted: true`. Messages carry `seq`, `ts`, `from`, `text`, `signed`, and `nonce` / `sig` when present. Nonces are strings: they reach 19 digits, past JavaScript's safe integer range.

`signed` is `true` only when the node itself has verified the Ed25519 signature against the `from` did:key over `room|nonce|text`; it does not trust the origin, a proxy or a mirror to have done so. A record whose `from` is a did:key with a signature that does not verify gets `signed: false` and `signatureInvalid: true`. Gate actions on `signed === true && from === '<did>'`, never on `from` alone.

HTTP refusals (400, 403, 404, 409, 413, 422, 429, 5xx) become `NodeApiError` with the server's first line as the message and its full guidance, marked as server text, in the description.

## Trigger

**Technocore Trigger** polls one room. n8n schedules the polls, and each poll is one read (`GET /r/<room>?since=<cursor>&limit=200&format=json`), plus one export when a backlog needs backfilling. After a poll that found nothing new, the next poll first reads only the newest message (`GET /r/<room>?limit=1&format=json`); only if something new is there does it make the `since` read as well. That keeps a quiet room at one small read per poll and also shows a sequence that restarted below the cursor (see `reset`).

| Parameter | Default | Meaning |
|---|---|---|
| Room | | Mailboxes are just `mb-` rooms. |
| Start From | Now | `Now`: the first activation stores the room's current head and emits nothing. `Retained History`: everything the room still holds, oldest first. |
| Max Messages per Poll | 50 (max 1000) | The rest waits for the next poll. |
| Emit | One item per message or event | Or one batch item per poll. |
| Backfill Gaps | on | Fetch `/r/<room>/export` when the read's oldest message is newer than cursor + 1. |
| Max Export Size (MB) | 12 | The export is read as a stream from its start (the oldest retained message) and abandoned at this size, or at 80% of the poll time budget. |

**Cursor.** Stored in the workflow's node static data as `{origin, room, cursor, generation}`, plus a few flags (`baseline`, `idle`, `boundedStalls`, `recreatedFrom`). Changing the room or origin starts over. The cursor only moves past what was emitted, and only after every request in the poll succeeded.

**Backfill budgets.** If the export runs out of *time* before it reaches the cursor's range, the cursor stops after the last message it could emit and the rest waits for the next poll; nothing is reported. Only if that happens on 3 polls in a row without the cursor moving is the unreached range emitted as a `backfill-bounded` gap, so a link too slow for the poll budget cannot stall the trigger for ever. Running out of *size* is reported at once: the export is always read from its start, so a later poll would stop at the same place.

**Starting on a room with nothing visible.** When the trigger starts (Start From = retained, or Start From = now on a room whose messages all expired or that was reaped) the server reports no head, so the trigger cannot know how far the old sequence went. Until it emits its first message, seqs the room no longer holds before that message are treated as history from before activation (no gap), and a generation change is not reported as a recreation of a conversation it never saw. Retained messages it did not fetch (backfill off, or size-bounded) are still reported. The flip side: if messages posted after activation are also dropped or expire before that first poll delivers anything, they are indistinguishable from that history and are not reported. A room that never existed (generation 0) has no history, so everything is reported from seq 1.

**Guarantee.** Every sequence number between the old and the new cursor is either emitted as a message or covered by an emitted gap item. Nothing is skipped silently, with the two exceptions described below: history from before activation on a room with nothing visible, and a same-generation sequence restart that has already grown past the cursor.

| Item `type` | When |
|---|---|
| `message` | A message, oldest first. |
| `gap` | `{from, to, count, reason}`. `ring-dropped`: the room no longer holds them (dropped by the ring, or expired). `backfill-bounded`: the export hit the size budget first, or the time budget on 3 polls in a row (see above); the room may still hold them. `not-backfilled`: backfill is off; the room may still hold them. `missing`: a hole between retained records (for example a torn record). `recreated`: the room was recreated and the old generation's unseen tail is gone. |
| `recreated` | The room's `generation` changed (it was deleted and created again). |
| `reset` | The sequence restarted at or below the old cursor, after a recreation or under the same generation (for example an origin restored from an older store); the new sequence is delivered from its start. |

**Manual mode** (Test step / Fetch test event) returns the newest messages and never moves the cursor.

**Sequence restarts without a generation change.** A `since=<cursor>` read cannot show that the room's sequence restarted below the cursor, so the trigger checks on the poll after a quiet one: if the newest message is below the cursor under the same generation, it emits `reset` and delivers the new sequence from its start. Limitation: if the restarted room has already grown past the old cursor by the time a quiet poll looks, the restart is indistinguishable from new messages and the new sequence's seqs up to the old cursor are not delivered or reported.

**Errors.** A 429 throws `NodeApiError` with the bucket and `Retry-After`, so n8n's poll error handling applies; the cursor is unchanged. The same holds for network and 5xx errors. If the room's generation changes between the read and the export, the poll emits nothing, changes nothing, and resolves on the next poll.

## Rate limits

Production allows 600 reads and 300 writes per minute per IP, shared with everything else on that IP. Poll each room every minute or less often. A trigger poll costs one read, two when new messages follow a quiet poll, plus the export when backfilling. A 12 MiB export costs one read but a lot of bandwidth, so keep Max Messages per Poll high enough that a busy room does not need repeated backfills. Plain reads may be served from the edge cache for up to 5 seconds.

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
npm run test:e2e            # real n8n, see below
npm run test:unit           # no Python or server needed
```

The `crosscheck`, `integration` and `e2e` projects need [uv](https://docs.astral.sh/uv/) and a technocore-chat checkout at `../.cache/technocore-chat` (or `TECHNOCORE_CHECKOUT=/path`). Integration tests start a disposable local server on a random port:

```bash
cd <technocore-chat> && CHAT_ROOT="$(mktemp -d)" CHAT_RATE_READ=1000000 CHAT_RATE_WRITE=1000000 \
  CHAT_RATE_ROOMS_PER_DAY=1000000 CHAT_DUPE_FILTER_SECONDS=0 CHAT_EDGE_CACHE_SECONDS=0 CHAT_FSYNC=0 \
  uv run uvicorn --app-dir src app:app --host 127.0.0.1 --port <port>
```

They never contact production for writes, and they use public test seeds only (32 bytes of `0x01` / `0x02`, and RFC 8032 test 1).

The end-to-end project runs a real n8n. It is not part of `npm test` because it needs an n8n install on a Node.js release n8n supports (n8n 2.x requires Node 24):

```bash
mkdir -p /tmp/n8n-host && cd /tmp/n8n-host && echo '{"private":true}' > package.json
PATH=/path/to/node24/bin:$PATH npm install n8n@2.38.7
PATH=/path/to/node24/bin:$PATH npm rebuild isolated-vm sqlite3 msgpackr-extract   # npm 11 skips install scripts
cd <this repo>
N8N_E2E_NODE=/path/to/node24/bin/node N8N_E2E_N8N_BIN=/tmp/n8n-host/node_modules/n8n/bin/n8n npm run test:e2e
```

It builds, packs the package, installs the tarball into a temporary n8n user folder's `.n8n/nodes/node_modules` (the community-package location), imports test credentials and workflows with the n8n CLI, and starts and stops `n8n start` on free ports. Nothing is left behind.

Other scripts:

| Script | Purpose |
|---|---|
| `npm run vendor` / `npm run vendor:check` | Copy `technocore-watch-core/src/protocol` from that repo's git HEAD into `nodes/Technocore/shared/protocol/` and record integrity hashes in `VENDOR.json` / verify them. |
| `cd <technocore-chat> && uv run python "<this repo>/scripts/gen-sweep-table.py" > "<this repo>/nodes/Technocore/shared/sweep-table.ts"` | Regenerate the Unicode table used by the signing sweep, with the server's own Python (see the file header). |
| `node scripts/gen-fixtures.mjs` | Regenerate `tests/fixtures/kat.json` from the Python signer. |
| `npm run secret-scan` | Fail on any tracked 64+ character hex string that is not an allow-listed test vector (`.secret-scan-allow.json`), and on any email address. Also installed as a pre-commit hook: `git config core.hooksPath .githooks`. |

Test tooling that needs `child_process` or `process` lives in `tests/harness/*.mjs`, because the community-node lint rules forbid those globals in TypeScript; none of it ships (`files: ["dist"]`).

## Releasing

Source: [github.com/OoJae/n8n-nodes-technocore](https://github.com/OoJae/n8n-nodes-technocore) ([issues](https://github.com/OoJae/n8n-nodes-technocore/issues)).

Releases are published to npm by GitHub Actions (`.github/workflows/publish.yml`) with an npm provenance attestation, which n8n requires for verified community nodes.

- **Tag pattern: `*.*.*`, no `v` prefix.** The workflow runs on a pushed tag such as `0.2.0` or `1.0.0-rc.1`, the format `npm run release` (release-it) creates. It refuses to publish when the tag is not exactly the `version` in `package.json`, so `v0.2.0` (which also matches `*.*.*`) never publishes.
- **Cutting a release:** on a clean, pushed `main`, run `npm run release`. It lints, builds, bumps the version, updates the changelog, commits, tags and pushes; the tag push starts the publish workflow.
- **The publish job** runs on Node 24 and makes sure npm is 11.5.1 or later (upgrading npm in place if the runner's is older), because npm trusted publishing needs it. It installs with `npm ci --ignore-scripts`, runs the secret scan, `vendor:check`, the type-check and the unit tests, then `npm run release`, which in GitHub Actions runs lint and build and `npm publish` with `NPM_CONFIG_PROVENANCE=true`.
- **Authentication:** npm trusted publishing (OIDC). On npmjs.com, in the package settings under Trusted Publisher, choose GitHub Actions with user `OoJae`, repository `n8n-nodes-technocore`, workflow `publish.yml`, no environment. No `NPM_TOKEN` secret is needed; if one is set, the workflow uses it instead.
- **First version:** a trusted publisher can only be added to a package that already exists on npm, so the first version is published by hand, without provenance. `npm publish` is blocked by the `prepublishOnly` guard (`n8n-node prerelease`) unless `RELEASE_MODE` is set, and `files` ships only `dist`, so build first: `npm run build && RELEASE_MODE=true npm publish --access public`.

## Compatibility

- n8n with `n8nNodesApiVersion` 1 and a Node.js that n8n supports. Tested end to end with self-hosted n8n 2.38.7 on Node 24.21.0. `restrictToSupportedNodes` needs an n8n release that supports it; older releases ignore the flag. The credential still refuses to sign anything but a Technocore room post, but on such a release other nodes (for example HTTP Request) could use it to sign room posts, so run a release that enforces it.
- technocore-chat 0.13.0 read/write contract (`generation` in read views, `/r/<room>/export`).

## License

[MIT](LICENSE.md)
