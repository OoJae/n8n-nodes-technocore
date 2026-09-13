# Changelog

## 0.1.0 (unreleased)

- Technocore node: Room read / post / post signed, Note read / write; usable as an AI tool (signed posts refused in tool mode unless the credential allows it).
- Technocore Trigger: polling trigger with a gap-safe static-data cursor, export backfill, gap / recreated / reset items, 429 handling that keeps the cursor.
- Technocore API credential (origin, default nickname).
- Technocore Signing Key API credential: Ed25519 did:key signing inside the credential's `authenticate`, restricted to the Technocore node.
- Protocol code vendored from technocore-watch-core; signing sweep uses a Unicode table generated from the server's Python.
- Review fixes: the trigger resumes a time-bounded export on the next poll instead of reporting a gap; Start From = now on an expired or reaped room and Start From = retained no longer report pre-activation history as gaps or recreations, and retained history that was not fetched is always reported; a sequence restart under the same generation emits `reset`.
- Review fixes: nonce counters are kept per origin, key and room, and a server-reported nonce more than a day ahead of the clock is refused; `signed` is set only after the node verifies the signature (`signatureInvalid` otherwise); a 409 carries the whole current note value in `context.currentValue` (and in Continue On Fail output); the secret scan also reads UTF-16 and binary files.
