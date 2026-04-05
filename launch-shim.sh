#!/usr/bin/env bash
set -euo pipefail

OLLAMA_BASE_URL="${1:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${2:-qwen2.5-coder:14b}"
SHIM_MAX_TOOLS="${3:-26}"
SHIM_LOG="${4:-debug}"
PORT="${5:-8000}"
HOST="${6:-127.0.0.1}"

export OLLAMA_BASE_URL OLLAMA_MODEL SHIM_MAX_TOOLS SHIM_LOG PORT HOST

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting shim -> ${OLLAMA_BASE_URL} (${OLLAMA_MODEL}) on http://${HOST}:${PORT}"
node "${SCRIPT_DIR}/src/server.mjs"
