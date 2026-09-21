---
name: doctor
description: Diagnose Buchi AI Gateway Codex setup issues D1-D7 (buchi_doctor, read-only).
---

# Buchiai Gateway Doctor (Codex)

1. Call `buchi_doctor` (read-only, no consent needed).
2. Present D1–D7 unabridged, including the always-shown D7 notices.
3. The doctor NEVER sends tokens. For token validity and actual passage, direct the user to the `verify` skill.
4. NEVER read `~/.codex/auth.json` to "help" with auth diagnosis. For Codex-side auth state, ask the user to run `codex doctor` themselves and share only the auth section summary (never tokens).
