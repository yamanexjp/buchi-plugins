#!/usr/bin/env bash
# buchi SessionStart hook — entry point (Phase 3 implementation).
#
# Contract:
#  - Emits at most ONE status line (connection state; gateway HOST only).
#  - The token part of ANTHROPIC_BASE_URL is NEVER printed (host extraction and
#    healthz probing happen in session-check.mjs, which only outputs the host).
#  - MUST always exit 0, even if any internal step fails: a SessionStart
#    failure here must never cascade into a broken Claude Code session.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1; then
  # stderr is suppressed: only the single intended status line may be emitted.
  node "${dir}/session-check.mjs" 2>/dev/null || true
else
  echo "ぶち: 状態確認をスキップ（node が見つかりません）"
fi

exit 0
