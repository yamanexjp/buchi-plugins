---
name: setup
description: Connect Codex to the Buchi AI Gateway (buchi_setup: dry-run diff, explicit consent, apply).
---

# Buchiai Gateway Setup (Codex)

Connect Codex model calls to the Buchi AI Gateway (DLP proxy).

## Procedure (strict order)

1. Ask the user for: gateway URL, gateway token, auth mode (`api` = API key, `subscription` = ChatGPT subscription).
   - Prefer the token via the `BUCHI_GATEWAY_TOKEN` environment variable (user runs `read -s BUCHI_GATEWAY_TOKEN` + export in their terminal). A token passed as a tool argument stays in the session transcript.
   - NEVER ask for upstream API keys or OAuth tokens. NEVER read `~/.codex/auth.json`.
2. Call `buchi_setup` WITHOUT `apply` (dry-run). Present the masked diff and warnings as-is. Note the `plan:` value in the output.
3. Apply ONLY after the user's explicit consent: call `buchi_setup` again with the same values plus the SAME `plan_hash` value and `apply: true`. If the tool reports a plan mismatch, take a fresh dry-run (the file or arguments changed) — never bypass it.
4. After apply, instruct the user to restart Codex (TUI/IDE), then run the `status` skill and the `verify` skill.

## Rules

- Do NOT edit `~/.codex/config.toml` directly. All changes go through `buchi_setup`.
- Quote tool outputs verbatim (they are already masked). NEVER print, quote, or guess full tokens.
- If the tool reports a conflict, do NOT overwrite silently. Explain and ask; `overwrite: true` only with explicit consent.
- `subscription` mode requires `codex login`. There is no cost reduction from compression on subscription plans.
