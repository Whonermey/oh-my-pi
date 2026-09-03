Edit long-term memories by id. Only ids returned by `recall`.

Operations:
- `update`: replace content (`content`). Mnemopi may also set `importance` (0–1).
- `invalidate`: softly supersede/retire the memory. Mnemopi: optional `replacement_id`. Hindsight: optional `reason`; invalidated memories are excluded from recall but kept server-side (reversible).
- `forget`: permanently hard-delete — **Mnemopi only**. Hindsight has no hard delete; use `invalidate` instead.

Mnemopi fact ids — `recall` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion (Mnemopi).

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
