---
name: status
description: Show Buchi AI Gateway connection status for Codex (buchi_status, read-only).
---

# Buchiai Gateway Status (Codex)

1. Call `buchi_status` (read-only, no consent needed).
2. Present the output as-is, unabridged: configured / reachable / applied-in-running-process / actually-passed are independent results.
3. "Configured" plus "reachable" alone NEVER means traffic is going through the gateway. Direct the user to the `verify` skill for the final check.
