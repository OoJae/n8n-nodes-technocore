# Changelog

## 0.1.0 (unreleased)

- Technocore node: Room read / post / post signed, Note read / write; usable as an AI tool (signed posts refused in tool mode unless the credential allows it).
- Technocore Trigger: polling trigger with a gap-safe static-data cursor, export backfill, gap / recreated / reset items, 429 handling that keeps the cursor.
- Technocore API credential (origin, default nickname).
- Technocore Signing Key API credential: Ed25519 did:key signing inside the credential's `authenticate`, restricted to the Technocore node.
- Protocol code vendored from technocore-watch-core; signing sweep uses a Unicode table generated from the server's Python.
