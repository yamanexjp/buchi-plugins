---
name: verify
description: Verify Codex traffic actually passes the Buchi AI Gateway (buchi_verify, explicit opt-in).
---

# Buchiai Gateway Verify (Codex)

"Configured" and "reachable" are NOT proof. This skill proves that Codex's own
model request passed the gateway (response-ID correlation), or honestly
reports unconfirmed.

## Procedure (strict order)

1. Call `buchi_verify` WITHOUT `confirm` first. Present the [1/4], [2/4], [2b/4] results and the cost notice as-is. Note: the [2b/4] acceptance probe sends one cost-free request (placeholder key, rejected upstream) even before confirmation.
2. ONLY with the user's explicit consent, call `buchi_verify` with `confirm: true`.
   This sends exactly ONE minimal Codex request (`Reply with exactly: ok`) and
   may incur upstream cost / subscription consumption. Fixed prompt, minimal
   output, no retries. Note: one confirm-verify consumes 3 gateway requests
   (acceptance probe + model request + seen query) against rate/daily limits.
3. Present the [3/4] and [4/4] results as-is:
   - `通過確認済み` only when the gateway observed THIS Codex request's response ID
     AND the requesting provider matches the buchi config.
   - Anything else is `通過未確認` — never upgrade it. Follow the tool's guidance.

## Rules

- NEVER treat healthz success, config file contents, or a direct probe as passage proof.
- NEVER print full tokens or response internals beyond the tool output.
