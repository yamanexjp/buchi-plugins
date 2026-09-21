---
name: on
description: Reconnect Codex to the Buchi AI Gateway after off (buchi_on, setup must exist).
---

# Buchiai Gateway On (Codex)

1. If setup was never completed (no state), direct the user to the `setup` skill first.
2. The gateway token is required again (off removed it from the config). Prefer `BUCHI_GATEWAY_TOKEN`; NEVER ask for upstream keys.
3. Call `buchi_on` WITHOUT `apply` first, present the plan (note its `plan:` value), then apply ONLY after explicit consent (same `plan_hash` + `apply: true`).
4. After apply, instruct the user to restart Codex, then run `status` and `verify`.
