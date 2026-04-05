#!/usr/bin/env bash
set -euo pipefail

ANTHROPIC_BASE_URL="${1:-http://127.0.0.1:8000}"
ANTHROPIC_API_KEY="${2:-dummy}"
CLAUDE_CODE_ATTRIBUTION_HEADER=0

export ANTHROPIC_BASE_URL ANTHROPIC_API_KEY CLAUDE_CODE_ATTRIBUTION_HEADER

shift 2 2>/dev/null || true

echo "Launching Claude Code against ${ANTHROPIC_BASE_URL}"
echo "Claude Code compatibility header applied"
claude "$@"
