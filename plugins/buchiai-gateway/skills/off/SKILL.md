---
name: off
description: Disconnect Codex from the Buchi AI Gateway and restore prior config (buchi_off).
---

# Buchiai Gateway Off (Codex)

1. Call `buchi_off` WITHOUT `apply` (dry-run). Present what will be removed/restored and what `model_provider` will be set to. Without `state.json`, managed tables and `model_provider` are kept unless `force: true` is explicitly consented.
2. Restore ONLY after explicit consent: call `buchi_off` again with `apply: true`.
3. After apply, instruct the user to restart Codex.
4. If the tool reports missing state or conflicts, do NOT improvise. Present the manual recovery guidance (backups `config.toml.buchi-backup-*`) and stop. Without `state.json`, the tool keeps managed tables and `model_provider` untouched unless `force: true` is explicitly consented (force deletes them without restore).

## Rules

- Do NOT edit `~/.codex/config.toml` directly.
- Quote tool outputs verbatim (masked). NEVER print full tokens.
